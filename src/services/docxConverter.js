const path = require('path');
const fs = require('fs').promises;
const mammoth = require('mammoth');
const { ensureDirectory, fileToBase64 } = require('../utils/helpers');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (error) {
  console.warn('puppeteer not available, DOCX to image conversion may not work');
}

/**
 * Convert DOCX to HTML using mammoth
 * @param {string} docxPath - Path to the DOCX file
 * @returns {Promise<string>} HTML content
 */
async function convertDocxToHtml(docxPath) {
  const result = await mammoth.convertToHtml({ path: docxPath });

  if (result.messages.length > 0) {
    console.warn('DOCX conversion warnings:', result.messages);
  }

  return result.value;
}

/**
 * Convert HTML to image using puppeteer
 * @param {string} html - HTML content
 * @param {string} outputPath - Path to save the image
 * @returns {Promise<string>} Path to saved image
 */
async function htmlToImage(html, outputPath) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Set viewport for consistent rendering
    await page.setViewport({
      width: 1200,
      height: 1600,
      deviceScaleFactor: 2
    });

    // Create a styled HTML document
    const styledHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              background: white;
              max-width: 800px;
              margin: 0 auto;
              line-height: 1.6;
            }
            table {
              border-collapse: collapse;
              width: 100%;
              margin: 10px 0;
            }
            td, th {
              border: 1px solid #ccc;
              padding: 8px;
            }
            img {
              max-width: 100%;
            }
          </style>
        </head>
        <body>${html}</body>
      </html>
    `;

    await page.setContent(styledHtml, { waitUntil: 'networkidle0' });

    // Get the full page height
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle.boundingBox();

    // Take screenshot
    await page.screenshot({
      path: outputPath,
      fullPage: true,
      type: 'png'
    });

    await bodyHandle.dispose();
    return outputPath;
  } finally {
    await browser.close();
  }
}

/**
 * Convert DOCX to images
 * @param {string} docxPath - Path to the DOCX file
 * @param {string} outputDir - Directory to save images
 * @returns {Promise<Array<{page: number, base64: string, path: string}>>}
 */
async function convertDocxToImages(docxPath, outputDir) {
  await ensureDirectory(outputDir);

  const baseName = path.basename(docxPath, path.extname(docxPath));

  try {
    // Convert DOCX to HTML
    const html = await convertDocxToHtml(docxPath);

    // Convert HTML to image
    const imagePath = path.join(outputDir, `${baseName}.png`);
    await htmlToImage(html, imagePath);

    // Read and convert to base64
    const base64 = await fileToBase64(imagePath);

    return [{
      page: 1,
      base64,
      path: imagePath,
      mimeType: 'image/png'
    }];
  } catch (error) {
    throw new Error(`Failed to convert DOCX: ${error.message}`);
  }
}

module.exports = {
  convertDocxToImages,
  convertDocxToHtml
};
