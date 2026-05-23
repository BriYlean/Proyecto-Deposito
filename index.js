const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const session = require("express-session");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");       // Añadido para leer los certificados
const https = require("https"); // Añadido para crear el servidor HTTPS

dotenv.config();
const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
    dotfiles: "ignore",
    index: false,
    maxAge: "1d",
}));
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
});

// ============================================
// SESIÓN
// ============================================
app.use(session({
    secret: process.env.SESSION_SECRET || "logistica-secret-2024",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' || Boolean(process.env.SSL_CERT),
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000  // 8 horas
    }
}));

// ============================================
// BASE DE DATOS
// ============================================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

function handleServerError(res, error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Error interno del servidor." });
}

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN
// Protege todas las rutas excepto /login y /api/auth/*
// ============================================
function requireAuth(req, res, next) {
    const rutasPublicas = ['/login', '/api/auth/login', '/api/auth/logout'];
    if (rutasPublicas.includes(req.path)) return next();

    if (!req.session || !req.session.usuario) {
        // Si es una petición API, devuelve 401
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ success: false, message: 'No autorizado' });
        }
        // Si es una página HTML, redirige al login
        return res.redirect('/login');
    }
    next();
}

app.use(requireAuth);

// ============================================
// NAVEGACIÓN (páginas HTML)
// ============================================
app.get("/login", (req, res) => {
    if (req.session.usuario) return res.redirect('/');
    res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.get("/", (req, res) => {
    if (!req.session.usuario) return res.redirect('/login');
    res.sendFile(path.join(__dirname, "views", "index.html"));
});

app.get("/productos", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "productos.html")));

app.get("/pedidos", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "pedidos.html")));

app.get("/listado", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "listado.html")));

app.get("/registro", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "registro.html")));

app.get("/egreso", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "egreso.html")));

app.get("/movimientos", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "movimientos.html")));

app.get("/movimientos", (req, res) =>
    res.sendFile(path.join(__dirname, "views", "movimientos.html")));

// ============================================
// API AUTH
// ============================================

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
    const { correo, password } = req.body;

    if (!correo || !password) {
        return res.status(400).json({ success: false, message: "Completá todos los campos." });
    }

    try {
        const [[usuario]] = await db.query(
            "SELECT * FROM usuarios WHERE correo = ? AND estado = 1 LIMIT 1",
            [correo]
        );

        if (!usuario) {
            return res.status(401).json({ success: false, message: "Credenciales incorrectas." });
        }

        const passwordValida = await bcrypt.compare(password, usuario.contrasena);

        if (!passwordValida) {
            return res.status(401).json({ success: false, message: "Credenciales incorrectas." });
        }

        // Guardar en sesión (sin la contraseña)
        req.session.usuario = {
            id_usuario: usuario.id_usuario,
            nombre: usuario.nombre,
            correo: usuario.correo,
            rol: usuario.rol
        };

        res.json({
            success: true,
            usuario: req.session.usuario
        });

    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ success: false, message: "Error interno del servidor." });
    }
});

// POST /api/auth/logout
app.post("/api/auth/logout", (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// GET /api/auth/me — para verificar sesión activa desde el frontend
app.get("/api/auth/me", (req, res) => {
    if (!req.session.usuario) {
        return res.status(401).json({ success: false });
    }
    res.json({ success: true, usuario: req.session.usuario });
});

// ============================================
// API DASHBOARD
// ============================================
app.get("/api/dashboard", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const offset = (page - 1) * limit;
        const search = req.query.search || "";

        let baseQuery = `
            FROM stock s
            INNER JOIN productos p ON s.id_producto = p.id_producto
            WHERE p.sku LIKE ? OR p.nombre_producto LIKE ?
        `;
        const params = [`%${search}%`, `%${search}%`];

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) as total ${baseQuery}`, params);

        const [rows] = await db.query(`
            SELECT 
                p.id_producto, p.sku AS SKU, p.nombre_producto AS Producto, 
                p.categoria AS Categoria, s.cantidad AS 'Cant. Actual', 
                p.stock_minimo AS stock_minimo, p.stock_minimo AS 'Min. Requerido',
                s.ubicacion_almacen AS 'Ubicación',
                'OK' AS Estado
            ${baseQuery}
            LIMIT ? OFFSET ?
        `, [...params, Number(limit), Number(offset)]);

        const totalAlertas = rows.filter(
            (r) => r["Cant. Actual"] <= r.stock_minimo
        ).length;

        res.json({
            success: true,
            data: rows,
            totalItems: total,
            totalPages: Math.ceil(total / limit),
            currentPage: page,
            totalAlertas: totalAlertas,
        });
    } catch (error) {
        return handleServerError(res, error);
    }
});

// ============================================
// API PEDIDOS
// ============================================
app.get("/api/pedidos/estado-productos", async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT p.id_producto, p.sku AS SKU, p.nombre_producto AS Producto,
            COALESCE(SUM(s.cantidad), 0) AS StockFisico,
            pp.nro_pedido AS NroPedidoPendiente,
            pp.id_pedido AS IdPedidoPendiente
            FROM productos p
            LEFT JOIN stock s ON p.id_producto = s.id_producto
            LEFT JOIN pedidos_proveedor pp ON p.id_producto = pp.id_producto AND pp.estado = 'Pendiente'
            GROUP BY p.id_producto, pp.nro_pedido, pp.id_pedido
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        return handleServerError(res, error);
    }
});

app.post("/api/pedidos/registrar", async (req, res) => {
    const { nro_pedido, id_producto, cantidad_bultos } = req.body;
    if (!nro_pedido || !id_producto) {
        return res.status(400).json({ success: false, error: "Faltan datos requeridos." });
    }
    try {
        await db.query(
            "INSERT INTO pedidos_proveedor (nro_pedido, id_producto, cantidad_bultos_pedidos, estado) VALUES (?, ?, ?, 'Pendiente')",
            [nro_pedido, id_producto, cantidad_bultos]
        );
        res.json({ success: true, message: "Pedido registrado" });
    } catch (error) {
        return handleServerError(res, error);
    }
});

app.put("/api/pedidos/cambiar-estado", async (req, res) => {
    const { id_pedido, nuevo_estado } = req.body;
    if (!id_pedido || !nuevo_estado) {
        return res.status(400).json({ success: false, error: "Faltan datos." });
    }
    try {
        await db.query(
            "UPDATE pedidos_proveedor SET estado = ? WHERE id_pedido = ?",
            [nuevo_estado, id_pedido]
        );
        res.json({ success: true, message: "Estado actualizado" });
    } catch (error) {
        return handleServerError(res, error);
    }
});

// ============================================
// API PRODUCTOS
// ============================================
app.get('/api/productos', async (req, res) => {
    try {
        const search = req.query.search || "";
        const [rows] = await db.query(`
            SELECT
                p.id_producto,
                p.sku          AS SKU,
                p.nombre_producto AS Producto,
                p.categoria    AS Categoria,
                p.stock_minimo AS stock_minimo,
                COALESCE(SUM(s.cantidad), 0) AS cantidad_actual
            FROM productos p
            LEFT JOIN stock s ON p.id_producto = s.id_producto
            WHERE p.sku LIKE ? OR p.nombre_producto LIKE ?
            GROUP BY p.id_producto
            ORDER BY p.nombre_producto ASC
        `, [`%${search}%`, `%${search}%`]);

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error("Error en GET /api/productos:", error);
        return handleServerError(res, error);
    }
});

app.put('/api/productos/:id', async (req, res) => {
    if (!req.session.usuario || req.session.usuario.rol !== 'Administrador') {
        return res.status(403).json({ success: false, message: "Acción restringida a Administradores." });
    }

    const { id } = req.params;
    const { sku, nombre, categoria, stock_minimo } = req.body;

    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, message: "ID inválido." });
    }
    if (!sku || !nombre) {
        return res.status(400).json({ success: false, message: "SKU y Nombre son requeridos." });
    }

    try {
        const [result] = await db.query(
            "UPDATE productos SET sku = ?, nombre_producto = ?, categoria = ?, stock_minimo = ? WHERE id_producto = ?",
            [sku.trim(), nombre.trim(), categoria?.trim() || null, stock_minimo || 0, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: "Producto no encontrado." });
        }
        console.log(`[ADMIN] Producto editado: ID=${id}, Usuario=${req.session.usuario.correo}`);
        res.json({ success: true, message: "Producto actualizado correctamente." });
    } catch (error) {
        console.error("Error al actualizar producto:", error);
        return handleServerError(res, error);
    }
});

app.post('/api/productos/registrar', async (req, res) => {
    const { sku, nombre, codigo_barras, categoria, stock_minimo } = req.body;
    if (!sku || !nombre) {
        return res.status(400).json({ success: false, message: "SKU y nombre son requeridos." });
    }
    const codigoFinal = (codigo_barras === '' || codigo_barras === undefined) ? null : codigo_barras;
    try {
        await db.query(
            "INSERT INTO productos (sku, nombre_producto, codigo_barras, categoria, stock_minimo) VALUES (?, ?, ?, ?, ?)",
            [sku, nombre, codigoFinal, categoria, stock_minimo]
        );
        res.json({ success: true, message: "Producto registrado correctamente" });
    } catch (error) {
        console.error("Error SQL:", error);
        return handleServerError(res, error);
    }
});

app.delete('/api/productos/:id', async (req, res) => {
    if (!req.session.usuario || req.session.usuario.rol !== 'Administrador') {
        return res.status(403).json({ success: false, message: "Acción restringida a Administradores." });
    }

    const { id } = req.params;
    if (!id || isNaN(id)) {
        return res.status(400).json({ success: false, message: "ID de producto inválido." });
    }

    try {
        const [[producto]] = await db.query(
            "SELECT id_producto, nombre_producto FROM productos WHERE id_producto = ? LIMIT 1",
            [id]
        );
        if (!producto) {
            return res.status(404).json({ success: false, message: "Producto no encontrado." });
        }

        await db.query("DELETE FROM pedidos_proveedor WHERE id_producto = ?", [id]);
        await db.query("DELETE FROM stock WHERE id_producto = ?", [id]);
        await db.query("DELETE FROM productos WHERE id_producto = ?", [id]);

        console.log(`[ADMIN] Producto eliminado: ID=${id}, Nombre="${producto.nombre_producto}", Usuario=${req.session.usuario.correo}`);
        res.json({ success: true, message: `Producto "${producto.nombre_producto}" eliminado correctamente.` });
    } catch (error) {
        console.error("Error al eliminar producto:", error);
        return handleServerError(res, error);
    }
});

// ============================================
// INICIAR SERVIDOR (HTTP y HTTPS)
// ============================================
const PORT = process.env.PORT || 3002;

// Levantamos el servidor HTTP estándar
app.listen(PORT, () => {
    console.log(`Servidor HTTP local activo en http://localhost:${PORT}`);
});

// Si existen las credenciales en el .env, levantamos también el servidor HTTPS
if (process.env.PORT_HTTPS && process.env.SSL_CERT && process.env.SSL_KEY) {
    try {
        const httpsOptions = {
            key: fs.readFileSync(path.resolve(__dirname, process.env.SSL_KEY)),
            cert: fs.readFileSync(path.resolve(__dirname, process.env.SSL_CERT))
        };
        
        const PORT_HTTPS = process.env.PORT_HTTPS;
        
        https.createServer(httpsOptions, app).listen(PORT_HTTPS, () => {
            console.log(`Servidor HTTPS (Seguro) activo en https://localhost:${PORT_HTTPS}`);
        });
    } catch (error) {
        console.error("⚠️ No se pudo iniciar el servidor HTTPS. Verifica que los archivos cert.pem y key.pem existan en la carpeta ./certs:", error.message);
    }
}