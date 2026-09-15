const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const sharp = require('sharp');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];

function isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Detect archive type by reading the first 8 bytes (magic bytes)
 */
function detectArchiveType(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(8);
        const bytesRead = fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);

        if (bytesRead < 4) return 'unknown';

        // ZIP magic: 'PK\x03\x04' or 'PK\x05\x06' or 'PK\x07\x08'
        if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
            return 'zip';
        }

        // RAR magic: 'Rar!\x1A\x07' (RAR4 and RAR5)
        if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) {
            return 'rar';
        }

        // 7z magic: '7z\xBC\xAF\x27\x1C'
        if (buffer[0] === 0x37 && buffer[1] === 0x7A && buffer[2] === 0xBC && buffer[3] === 0xAF) {
            return '7z';
        }

        // PDF magic: '%PDF'
        if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
            return 'pdf';
        }
    } catch (e) {
        console.warn('detectArchiveType error:', e.message);
    }
    return 'unknown';
}

/**
 * Recursively find all image files within a directory
 */
function findImageFilesRecursively(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    try {
        const list = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of list) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(findImageFilesRecursively(fullPath));
            } else if (entry.isFile() && isImageFile(entry.name)) {
                results.push(fullPath);
            }
        }
    } catch (e) {
        console.warn('findImageFilesRecursively error:', e.message);
    }
    return results;
}

/**
 * Flatten and standardize extracted pages into destDir/page_0001.ext, page_0002.ext...
 * Cleans up all subdirectories and non-image files.
 */
function organizeExtractedPages(destDir) {
    const allImages = findImageFilesRecursively(destDir);
    if (allImages.length === 0) return [];

    // Sort images naturally
    allImages.sort((a, b) => naturalSort(path.basename(a), path.basename(b)));

    // Rename images sequentially to temporary names first to avoid collision
    const tempNames = [];
    for (let i = 0; i < allImages.length; i++) {
        const ext = path.extname(allImages[i]).toLowerCase();
        const tempPath = path.join(destDir, `__temp_page_${String(i + 1).padStart(4, '0')}${ext}`);
        fs.renameSync(allImages[i], tempPath);
        tempNames.push(tempPath);
    }

    // Clean up all subdirectories and non-image files in destDir
    const entries = fs.readdirSync(destDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } else if (!entry.name.startsWith('__temp_page_')) {
            fs.unlinkSync(fullPath);
        }
    }

    // Rename temp pages to final page_XXXX.ext names
    const pages = [];
    for (let i = 0; i < tempNames.length; i++) {
        const ext = path.extname(tempNames[i]).toLowerCase();
        const pageName = `page_${String(i + 1).padStart(4, '0')}${ext}`;
        const finalPath = path.join(destDir, pageName);
        fs.renameSync(tempNames[i], finalPath);
        pages.push(pageName);
    }

    return pages;
}

/**
 * Extract a CBZ (ZIP) archive to a destination directory
 */
async function extractCBZ(filePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    // Check if it's actually a RAR archive
    const type = detectArchiveType(filePath);
    if (type === 'rar') {
        return extractCBR(filePath, destDir);
    }

    try {
        const directory = await unzipper.Open.file(filePath);
        const imageFiles = directory.files.filter(f => f.type === 'File' && isImageFile(f.path));

        if (imageFiles.length === 0) {
            // Might be a RAR disguised as ZIP
            if (type !== 'rar') {
                return extractCBR(filePath, destDir);
            }
            return [];
        }

        // Extract files
        for (const file of imageFiles) {
            const normalizedPath = file.path.replace(/\\/g, '/');
            const targetFilePath = path.join(destDir, normalizedPath);
            fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
            const content = await file.buffer();
            fs.writeFileSync(targetFilePath, content);
        }

        return organizeExtractedPages(destDir);
    } catch (zipErr) {
        console.warn('unzipper failed, attempting CBR fallback:', zipErr.message);
        return extractCBR(filePath, destDir);
    }
}

/**
 * Extract a CBR (RAR) archive to a destination directory
 */
async function extractCBR(filePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    // Check if it's actually a ZIP archive
    const type = detectArchiveType(filePath);
    if (type === 'zip') {
        return extractCBZ(filePath, destDir);
    }

    // 1. Try node-unrar-js
    try {
        const { createExtractorFromFile } = require('node-unrar-js');
        const wasmBinary = fs.readFileSync(
            require.resolve('node-unrar-js/dist/js/unrar.wasm')
        );

        const extractor = await createExtractorFromFile({
            filepath: filePath,
            targetPath: destDir,
            wasmBinary,
            filenameTransform: (fn) => fn.replace(/\\/g, '/')
        });

        // Filter: only extract non-directory image files
        const { files } = extractor.extract({
            files: (header) => !header.flags.directory && isImageFile(header.name)
        });

        // Drain iterator to completion (mandatory in node-unrar-js to free C++ memory)
        for (const _ of files) {}

        const pages = organizeExtractedPages(destDir);
        if (pages.length > 0) {
            return pages;
        }
    } catch (unrarErr) {
        console.warn('node-unrar-js extraction error:', unrarErr.message);
    }

    // 2. Fallback to 7z CLI if available
    try {
        await execFileAsync('7z', ['x', '-y', `-o${destDir}`, filePath]);
        const pages = organizeExtractedPages(destDir);
        if (pages.length > 0) return pages;
    } catch (e) {}

    // 3. Fallback to unrar CLI if available
    try {
        await execFileAsync('unrar', ['x', '-y', '-o+', filePath, destDir + '/']);
        const pages = organizeExtractedPages(destDir);
        if (pages.length > 0) return pages;
    } catch (e) {}

    // 4. Fallback to unzipper in case archive header was non-standard but zip-readable
    try {
        const pages = await extractCBZ(filePath, destDir);
        if (pages.length > 0) return pages;
    } catch (e) {}

    throw new Error('Failed to extract CBR archive: no readable images found or unsupported format');
}

/**
 * Unified archive extractor: automatically chooses CBR or CBZ based on magic bytes or extension
 */
async function extractArchive(filePath, destDir) {
    const type = detectArchiveType(filePath);
    if (type === 'zip') {
        return extractCBZ(filePath, destDir);
    } else if (type === 'rar') {
        return extractCBR(filePath, destDir);
    } else {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.cbz') {
            return extractCBZ(filePath, destDir);
        }
        return extractCBR(filePath, destDir);
    }
}

/**
 * Count pages in a PDF file
 */
async function countPDFPages(filePath) {
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.numpages;
}

/**
 * Generate a cover thumbnail from a comic page image
 */
async function generateCoverFromImage(imagePath, coverPath) {
    const coversDir = path.dirname(coverPath);
    fs.mkdirSync(coversDir, { recursive: true });

    await sharp(imagePath)
        .resize(300, 450, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toFile(coverPath);
}

/**
 * Generate a cover thumbnail from an arbitrary image Buffer
 */
async function generateCoverFromBuffer(buffer, coverPath) {
    const coversDir = path.dirname(coverPath);
    fs.mkdirSync(coversDir, { recursive: true });

    await sharp(buffer)
        .resize(300, 450, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toFile(coverPath);
}

/**
 * Generate a cover thumbnail from a PDF page using pdftoppm (with fallback to placeholder)
 */
async function generateCoverFromPDF(pdfPath, coverPath, pageNum = 1) {
    const coversDir = path.dirname(coverPath);
    fs.mkdirSync(coversDir, { recursive: true });

    // Try extracting real page image using pdftoppm
    const tempPrefix = path.join(coversDir, `temp_pdf_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
    try {
        await execFileAsync('pdftoppm', [
            '-jpeg',
            '-r', '150',
            '-f', String(pageNum),
            '-l', String(pageNum),
            pdfPath,
            tempPrefix
        ]);

        const basePrefix = path.basename(tempPrefix);
        const candidates = fs.readdirSync(coversDir).filter(f => f.startsWith(basePrefix) && f.endsWith('.jpg'));

        if (candidates.length > 0) {
            const extractedImagePath = path.join(coversDir, candidates[0]);
            await generateCoverFromImage(extractedImagePath, coverPath);
            fs.unlinkSync(extractedImagePath);
            return true;
        }
    } catch (err) {
        console.warn('pdftoppm extraction failed or not available, falling back to SVG placeholder:', err.message);
    }

    // Clean up any remaining temp files with this prefix
    try {
        const basePrefix = path.basename(tempPrefix);
        const files = fs.readdirSync(coversDir).filter(f => f.startsWith(basePrefix));
        for (const f of files) fs.unlinkSync(path.join(coversDir, f));
    } catch (e) {}

    // Fallback: create placeholder cover for PDFs
    const svg = `
    <svg width="300" height="450" xmlns="http://www.w3.org/2000/svg">
      <rect width="300" height="450" fill="#1a1a2e" rx="8"/>
      <rect x="20" y="20" width="260" height="410" fill="#16213e" rx="4" stroke="#0f3460" stroke-width="1"/>
      <text x="150" y="200" text-anchor="middle" fill="#e94560" font-family="sans-serif" font-size="48" font-weight="bold">PDF</text>
      <text x="150" y="250" text-anchor="middle" fill="#a0a0b8" font-family="sans-serif" font-size="14">${path.basename(pdfPath, '.pdf').substring(0, 25)}</text>
    </svg>
  `;

    await sharp(Buffer.from(svg))
        .jpeg({ quality: 85 })
        .toFile(coverPath);
    return false;
}

/**
 * Generate a cover from an arbitrary page of a book
 */
async function generateCoverFromPage(book, pageNum, coverPath, originalsDir, extractedDir) {
    if (book.type === 'pdf') {
        const pdfPath = path.join(originalsDir, book.filename);
        if (!fs.existsSync(pdfPath)) throw new Error('PDF file not found');
        await generateCoverFromPDF(pdfPath, coverPath, pageNum);
    } else {
        const bookExtractedDir = path.join(extractedDir, String(book.id));
        if (!fs.existsSync(bookExtractedDir) || fs.readdirSync(bookExtractedDir).filter(isImageFile).length === 0) {
            // Auto-extract if missing
            const originalPath = path.join(originalsDir, book.filename);
            if (fs.existsSync(originalPath)) {
                await extractArchive(originalPath, bookExtractedDir);
            }
        }

        const files = fs.readdirSync(bookExtractedDir).filter(isImageFile).sort(naturalSort);
        if (files.length === 0) {
            throw new Error('No images found in comic archive');
        }

        const pageIdx = pageNum - 1;
        if (pageIdx < 0 || pageIdx >= files.length) {
            throw new Error(`Page ${pageNum} out of range (1 - ${files.length})`);
        }

        const pagePath = path.join(bookExtractedDir, files[pageIdx]);
        await generateCoverFromImage(pagePath, coverPath);
    }
}

module.exports = {
    extractCBZ,
    extractCBR,
    extractArchive,
    detectArchiveType,
    organizeExtractedPages,
    countPDFPages,
    generateCoverFromImage,
    generateCoverFromBuffer,
    generateCoverFromPDF,
    generateCoverFromPage,
    isImageFile,
    naturalSort
};
