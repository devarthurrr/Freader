const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getSetting, setSetting } = require('../utils/database');
const {
    generateCoverFromPage,
    generateCoverFromBuffer,
    generateCoverFromImage
} = require('../utils/extract');

const ORIGINALS_DIR = path.join(__dirname, '..', 'data', 'originals');
const EXTRACTED_DIR = path.join(__dirname, '..', 'data', 'extracted');
const COVERS_DIR = path.join(__dirname, '..', 'data', 'covers');

// Configure multer for memory storage for custom cover upload
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB max
});

module.exports = function (db) {

    // GET /api/covers/settings — get cover settings (e.g. Comic Vine status)
    router.get('/settings', (req, res) => {
        try {
            const key = getSetting(db, 'comicvine_api_key', process.env.COMICVINE_API_KEY || '');
            res.json({
                comicvine_configured: !!key,
                comicvine_masked_key: key ? (key.length > 8 ? key.slice(0, 4) + '••••' + key.slice(-4) : '••••••••') : ''
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/covers/settings — save cover settings
    router.post('/settings', (req, res) => {
        try {
            const { comicvine_api_key } = req.body;
            if (comicvine_api_key !== undefined) {
                setSetting(db, 'comicvine_api_key', comicvine_api_key.trim());
            }
            res.json({ success: true, message: 'Settings saved' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/covers/pages/:bookId — get pages info for a book
    router.get('/pages/:bookId', (req, res) => {
        try {
            const bookId = parseInt(req.params.bookId, 10);
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            res.json({
                book_id: book.id,
                title: book.title,
                type: book.type,
                total_pages: book.total_pages
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/covers/search — search online sources (Comic Vine, Google Books, Open Library)
    router.get('/search', async (req, res) => {
        const query = req.query.query ? req.query.query.trim() : '';
        const source = req.query.source || 'comicvine';

        if (!query) {
            return res.status(400).json({ error: 'Query parameter is required' });
        }

        const apiKey = getSetting(db, 'comicvine_api_key', process.env.COMICVINE_API_KEY || '');
        const results = [];
        let requiresKey = false;
        let errorMessage = null;

        // 1. Comic Vine API
        if (source === 'comicvine' || source === 'all') {
            if (!apiKey) {
                requiresKey = true;
                if (source === 'comicvine') {
                    return res.json({
                        results: [],
                        requires_key: true,
                        source: 'comicvine',
                        message: 'Comic Vine requires a free API key. Configure it in Settings or select Google Books or Open Library.'
                    });
                }
            } else {
                try {
                    const cvUrl = `https://comicvine.gamespot.com/api/search/?api_key=${encodeURIComponent(apiKey)}&format=json&resources=issue,volume&query=${encodeURIComponent(query)}&limit=15`;
                    const response = await fetch(cvUrl, {
                        headers: {
                            'User-Agent': 'Freader-Comic-Reader/1.0 (self-hosted comic reader)'
                        },
                        signal: AbortSignal.timeout(10000)
                    });

                    if (response.ok) {
                        const data = await response.json();
                        if (data.results && Array.isArray(data.results)) {
                            for (const item of data.results) {
                                const coverUrl = item.image ? (item.image.medium_url || item.image.small_url || item.image.original_url) : null;
                                if (coverUrl) {
                                    const publisher = (item.publisher && item.publisher.name) ||
                                        (item.volume && item.volume.publisher && item.volume.publisher.name) || '';
                                    const issueText = item.issue_number ? `Issue #${item.issue_number}` : '';
                                    const year = item.start_year || (item.cover_date ? item.cover_date.substring(0, 4) : '');

                                    results.push({
                                        id: `cv-${item.id}`,
                                        title: item.name || (item.volume && item.volume.name) || query,
                                        subtitle: [issueText, publisher, year].filter(Boolean).join(' · '),
                                        publisher,
                                        year,
                                        cover_url: coverUrl,
                                        source: 'comicvine'
                                    });
                                }
                            }
                        }
                    } else if (response.status === 401 || response.status === 403) {
                        requiresKey = true;
                        errorMessage = 'Invalid Comic Vine API key.';
                    }
                } catch (err) {
                    console.error('Comic Vine API error:', err.message);
                    errorMessage = err.message;
                }
            }
        }

        // 2. Google Books API
        if (source === 'googlebooks' || source === 'all') {
            try {
                const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=15`;
                const response = await fetch(gbUrl, { signal: AbortSignal.timeout(10000) });
                if (response.ok) {
                    const data = await response.json();
                    if (data.items && Array.isArray(data.items)) {
                        for (const item of data.items) {
                            const info = item.volumeInfo || {};
                            let coverUrl = info.imageLinks ? (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail) : null;
                            if (coverUrl) {
                                // Ensure https to prevent mixed-content blocks
                                coverUrl = coverUrl.replace(/^http:\/\//i, 'https://');
                                const year = (info.publishedDate || '').substring(0, 4);
                                const authors = (info.authors || []).slice(0, 2).join(', ');

                                results.push({
                                    id: `gb-${item.id}`,
                                    title: info.title,
                                    subtitle: [authors, info.publisher, year].filter(Boolean).join(' · '),
                                    publisher: info.publisher || '',
                                    year,
                                    cover_url: coverUrl,
                                    source: 'googlebooks'
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Google Books API error:', err.message);
            }
        }

        // 3. Open Library API
        if (source === 'openlibrary' || source === 'all') {
            try {
                const olUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=15`;
                const response = await fetch(olUrl, { signal: AbortSignal.timeout(10000) });
                if (response.ok) {
                    const data = await response.json();
                    if (data.docs && Array.isArray(data.docs)) {
                        for (const doc of data.docs) {
                            if (doc.cover_i) {
                                const coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
                                const authors = (doc.author_name || []).slice(0, 2).join(', ');
                                const publisher = (doc.publisher || [])[0] || '';
                                const year = doc.first_publish_year ? String(doc.first_publish_year) : '';

                                results.push({
                                    id: `ol-${doc.key.replace(/\//g, '-')}`,
                                    title: doc.title,
                                    subtitle: [authors, publisher, year].filter(Boolean).join(' · '),
                                    publisher,
                                    year,
                                    cover_url: coverUrl,
                                    source: 'openlibrary'
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Open Library API error:', err.message);
            }
        }

        res.json({
            results,
            requires_key: requiresKey,
            source,
            error: errorMessage
        });
    });

    // POST /api/covers/apply/:bookId — apply cover from page, URL, or upload
    router.post('/apply/:bookId', upload.single('image'), async (req, res) => {
        try {
            const bookId = parseInt(req.params.bookId, 10);
            const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
            if (!book) return res.status(404).json({ error: 'Book not found' });

            fs.mkdirSync(COVERS_DIR, { recursive: true });
            const coverRelPath = `data/covers/${bookId}.jpg`;
            const coverAbsPath = path.join(COVERS_DIR, `${bookId}.jpg`);

            const type = req.body.type || (req.file ? 'upload' : 'url');

            if (type === 'page') {
                const pageNum = parseInt(req.body.page_num, 10) || 1;
                await generateCoverFromPage(book, pageNum, coverAbsPath, ORIGINALS_DIR, EXTRACTED_DIR);
            } else if (type === 'url') {
                const imageUrl = req.body.url;
                if (!imageUrl) return res.status(400).json({ error: 'Image URL is required' });

                const response = await fetch(imageUrl, {
                    headers: {
                        'User-Agent': 'Freader-Comic-Reader/1.0 (self-hosted comic reader)'
                    },
                    signal: AbortSignal.timeout(15000)
                });

                if (!response.ok) {
                    throw new Error(`Failed to download image: ${response.statusText}`);
                }

                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                await generateCoverFromBuffer(buffer, coverAbsPath);
            } else if (type === 'upload') {
                if (!req.file || !req.file.buffer) {
                    return res.status(400).json({ error: 'No image file uploaded' });
                }
                await generateCoverFromBuffer(req.file.buffer, coverAbsPath);
            } else {
                return res.status(400).json({ error: 'Invalid apply type. Must be "page", "url", or "upload".' });
            }

            // Update database with cover_path
            db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverRelPath, bookId);

            res.json({
                success: true,
                book_id: bookId,
                cover_url: `/api/reader/${bookId}/cover?t=${Date.now()}`
            });
        } catch (err) {
            console.error('Apply cover error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
