const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const sharp = require('sharp');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

function isImageFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

function naturalSort(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Extract a CBZ (ZIP) archive to a destination directory
 */
async function extractCBZ(filePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    const directory = await unzipper.Open.file(filePath);
    const imageFiles = directory.files
        .filter(f => f.type === 'File' && isImageFile(f.path))
        .sort((a, b) => naturalSort(a.path, b.path));

    const pages = [];
    for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        const ext = path.extname(file.path).toLowerCase();
        const pageName = `page_${String(i + 1).padStart(4, '0')}${ext}`;
        const destPath = path.join(destDir, pageName);

        const content = await file.buffer();
        fs.writeFileSync(destPath, content);
        pages.push(pageName);
    }

    return pages;
}

/**
 * Extract a CBR (RAR) archive to a destination directory
 */
async function extractCBR(filePath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    const { createExtractorFromFile } = require('node-unrar-js');
    const wasmBinary = fs.readFileSync(
        require.resolve('node-unrar-js/dist/js/unrar.wasm')
    );

    const extractor = await createExtractorFromFile({
        filepath: filePath,
        targetPath: destDir,
        wasmBinary
    });

    const { files } = extractor.extract();
    const extractedFiles = [];

    for (const file of files) {
        if (file.fileHeader && !file.fileHeader.flags.directory) {
            const fname = file.fileHeader.name;
            if (isImageFile(fname)) {
                extractedFiles.push(fname);
            }
        }
    }

    // Rename extracted files to sequential page names
    extractedFiles.sort((a, b) => naturalSort(a, b));
    const pages = [];

    for (let i = 0; i < extractedFiles.length; i++) {
        const srcPath = path.join(destDir, extractedFiles[i]);
        const ext = path.extname(extractedFiles[i]).toLowerCase();
        const pageName = `page_${String(i + 1).padStart(4, '0')}${ext}`;
        const destPath = path.join(destDir, pageName);

        if (fs.existsSync(srcPath) && srcPath !== destPath) {
            fs.renameSync(srcPath, destPath);
        }
        pages.push(pageName);
    }

    // Clean up any leftover subdirectories
    const entries = fs.readdirSync(destDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            fs.rmSync(path.join(destDir, entry.name), { recursive: true, force: true });
        }
    }

    return pages;
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

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

/**
 * Generate a cover thumbnail from a comic page image
 */
async function generateCoverFromImage(imagePath, coverPath) {
    await sharp(imagePath)
        .resize(300, 450, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toFile(coverPath);
}

/**
 * Generate a cover thumbnail from an arbitrary image Buffer
 */
async function generateCoverFromBuffer(buffer, coverPath) {
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

        // Find the generated file (pdftoppm names it like tempPrefix-1.jpg or tempPrefix-01.jpg)
        const basePrefix = path.basename(tempPrefix);
        const candidates = fs.readdirSync(coversDir).filter(f => f.startsWith(basePrefix) && f.endsWith('.jpg'));

        if (candidates.length > 0) {
            const extractedImagePath = path.join(coversDir, candidates[0]);
            await generateCoverFromImage(extractedImagePath, coverPath);
            fs.unlinkSync(extractedImagePath);
            return;
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
        // CBR or CBZ: look in extracted dir
        const bookExtractedDir = path.join(extractedDir, String(book.id));
        if (!fs.existsSync(bookExtractedDir)) {
            throw new Error('Extracted pages not found for comic');
        }

        const files = fs.readdirSync(bookExtractedDir).filter(isImageFile).sort();
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
    countPDFPages,
    generateCoverFromImage,
    generateCoverFromBuffer,
    generateCoverFromPDF,
    generateCoverFromPage,
    isImageFile
};
