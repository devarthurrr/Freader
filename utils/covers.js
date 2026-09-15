const path = require('path');
const fs = require('fs');
const { getSetting } = require('./database');
const { generateCoverFromBuffer } = require('./extract');

function cleanTitleForSearch(rawTitle) {
    if (!rawTitle) return '';
    let title = rawTitle;
    // Strip file extensions
    title = title.replace(/\.(cbr|cbz|pdf|rar|zip|epub)$/i, '');
    // Strip leading release/issue indexing like "0227-", "01 - ", "001. "
    title = title.replace(/^\d+[\s\-_.]+\s*/, '');
    // Strip parenthesized release/year tags: "(2016)", "(digital)", "(Zone-Telechargement)"
    title = title.replace(/\([^\)]*\)/g, ' ');
    // Strip bracketed tags: "[c2c]", "[Minutemen]"
    title = title.replace(/\[[^\]]*\]/g, ' ');
    // Strip underscores and consecutive dashes
    title = title.replace(/[_\-]+/g, ' ');
    // Strip extra whitespace
    title = title.replace(/\s+/g, ' ').trim();
    return title || rawTitle;
}

/**
 * Fetch the first cover image URL from Comic Vine for a given title
 */
async function fetchFirstComicVineCover(title, apiKey) {
    if (!apiKey) return null;
    const cleanQuery = cleanTitleForSearch(title);
    if (!cleanQuery) return null;

    try {
        const cvUrl = `https://comicvine.gamespot.com/api/search/?api_key=${encodeURIComponent(apiKey)}&format=json&resources=issue,volume&query=${encodeURIComponent(cleanQuery)}&limit=5`;
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
                    const coverUrl = item.image ? (item.image.medium_url || item.image.small_url || item.image.original_url || item.image.super_url) : null;
                    if (coverUrl) {
                        return coverUrl;
                    }
                }
            }
        }
    } catch (err) {
        console.warn('Comic Vine auto-fetch error:', err.message);
    }
    return null;
}

/**
 * Fetch the first available online cover:
 * 1. Comic Vine (primary)
 * 2. Google Books (fallback if Comic Vine key is missing or yields no results)
 * 3. Open Library (fallback)
 */
async function fetchFirstOnlineCover(title, apiKey) {
    // 1. Comic Vine
    if (apiKey) {
        const cvCover = await fetchFirstComicVineCover(title, apiKey);
        if (cvCover) return { url: cvCover, source: 'comicvine' };
    }

    const cleanQuery = cleanTitleForSearch(title);
    if (!cleanQuery) return null;

    // 2. Google Books fallback
    try {
        const gbUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanQuery)}&maxResults=5`;
        const response = await fetch(gbUrl, { signal: AbortSignal.timeout(8000) });
        if (response.ok) {
            const data = await response.json();
            if (data.items && Array.isArray(data.items)) {
                for (const item of data.items) {
                    const info = item.volumeInfo || {};
                    let coverUrl = info.imageLinks ? (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail) : null;
                    if (coverUrl) {
                        coverUrl = coverUrl.replace(/^http:\/\//i, 'https://');
                        return { url: coverUrl, source: 'googlebooks' };
                    }
                }
            }
        }
    } catch (e) {}

    // 3. Open Library fallback
    try {
        const olUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQuery)}&limit=5`;
        const response = await fetch(olUrl, { signal: AbortSignal.timeout(8000) });
        if (response.ok) {
            const data = await response.json();
            if (data.docs && Array.isArray(data.docs)) {
                for (const doc of data.docs) {
                    if (doc.cover_i) {
                        return { url: `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`, source: 'openlibrary' };
                    }
                }
            }
        }
    } catch (e) {}

    return null;
}

/**
 * Auto-fetch first cover from Comic Vine (with fallback) and apply to book
 */
async function autoFetchAndApplyCover(bookId, title, db, coversDir) {
    const apiKey = getSetting(db, 'comicvine_api_key', process.env.COMICVINE_API_KEY || '');
    const result = await fetchFirstOnlineCover(title, apiKey);
    if (!result || !result.url) return null;

    try {
        const response = await fetch(result.url, {
            headers: {
                'User-Agent': 'Freader-Comic-Reader/1.0 (self-hosted comic reader)'
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        fs.mkdirSync(coversDir, { recursive: true });
        const coverRel = `data/covers/${bookId}.jpg`;
        const coverAbs = path.join(coversDir, `${bookId}.jpg`);

        await generateCoverFromBuffer(buffer, coverAbs);
        db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverRel, bookId);
        return coverRel;
    } catch (err) {
        console.warn(`Failed to download and save auto-fetched cover for book ${bookId}:`, err.message);
    }
    return null;
}

module.exports = {
    cleanTitleForSearch,
    fetchFirstComicVineCover,
    fetchFirstOnlineCover,
    autoFetchAndApplyCover
};
