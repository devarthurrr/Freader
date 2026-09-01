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
 * Generate a cover thumbnail from a PDF first page
 */
async function generateCoverFromPDF(pdfPath, coverPath) {
    // We'll use a simple approach: create a placeholder cover for PDFs
    // since rendering PDF pages server-side without heavy deps is complex
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

module.exports = {
    extractCBZ,
    extractCBR,
    countPDFPages,
    generateCoverFromImage,
    generateCoverFromPDF,
    isImageFile
};
