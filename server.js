const express = require('express');
const path = require('path');
const cors = require('cors');
const { initDB } = require('./utils/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
const db = initDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/books', require('./routes/library')(db));
app.use('/api/covers', require('./routes/covers')(db));
app.use('/api/folders', require('./routes/folders')(db));
app.use('/api/reader', require('./routes/reader')(db));
app.use('/api/upload', require('./routes/upload')(db));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  📚 Freader is running at http://localhost:${PORT}\n`);
});
