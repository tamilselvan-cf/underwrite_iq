require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ============== CONFIGURATION ==============
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'uploads/temp');
const MAX_PAGES_PER_BATCH = 3;

// Component name to UUID mapping (from environment variables)
const COMPONENT_IDS = {
  'Signature': process.env.COMPONENT_ID_SIGNATURE,
  'Multi-Select': process.env.COMPONENT_ID_MULTI_SELECT,
  'File Upload': process.env.COMPONENT_ID_FILE_UPLOAD,
  'Short Input': process.env.COMPONENT_ID_SHORT_INPUT,
  'Sections': process.env.COMPONENT_ID_SECTIONS,
  'Dropdown': process.env.COMPONENT_ID_DROPDOWN,
  'Radio Select': process.env.COMPONENT_ID_RADIO_SELECT,
  'Table': process.env.COMPONENT_ID_TABLE,
  'Title': process.env.COMPONENT_ID_TITLE,
  'Long Input': process.env.COMPONENT_ID_LONG_INPUT
};

let pdfPoppler;
try {
  pdfPoppler = require('pdf-poppler');
} catch (error) {
  console.warn('pdf-poppler not available - PDF support disabled');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ============== SYSTEM PROMPT ==============
const SYSTEM_PROMPT = `You are a form structure analyzer. Analyze the provided form image(s) and extract the complete structure.

TASK: Identify all form fields and classify them into these component types ONLY:
- Signature: Signature lines or boxes
- Multi-Select: Checkboxes (multiple can be selected)
- File Upload: File/document attachment areas
- Short Input: Single-line text fields
- Sections: Section dividers or headers within the form
- Dropdown: Select/dropdown menus
- Radio Select: Radio buttons (single selection)
- Table: Tabular data entry with columns and rows
- Title: Bold text, headings that introduce/group fields
- Long Input: Multi-line text areas

DOCUMENT STRUCTURE - FLAT (NO SUBSECTIONS):
1. **SECTIONS**: Major sections with headers (highlighted/shaded backgrounds like "III. COVERAGE", "IV. EXPOSURES")
2. **FIELDS**: All items within a section are FIELDS (including titles like "HOSPITALS", "Self-Insured Retention (SIR):")

CRITICAL RULES:
1. **PRESERVE EXACT TEXT**: Copy all labels and titles EXACTLY as they appear in the document.
2. **EXCLUDE SERIAL NUMBERS**: Remove leading numbering/lettering from labels (A., B., 1., 2., I., II., etc.)
3. **SKIP INSTRUCTION TEXT**: Do NOT include instruction paragraphs. Only capture actual INPUT FIELDS.
4. **BOLD TEXT = Title component**: Bold/emphasized text that labels a group should be a Title component
5. Extract ALL visible options for Multi-Select, Radio Select, and Dropdown
6. For Table: extract column headers and COUNT the rows (rowCount)
7. Mark fields as required if they show asterisks (*) or "required"
8. Maintain top-to-bottom, left-to-right ordering
9. **ONLY INPUT FIELDS**: Only capture fields that have actual input areas.

RESPOND WITH ONLY VALID JSON in this exact format:
{
  "formTitle": "Form Title Here",
  "sections": [
    {
      "id": "section_1",
      "title": "COVERAGE",
      "order": 1,
      "fields": [
        {
          "id": "field_1",
          "component": "Radio Select",
          "label": "Does the applicant want to change the current insurance structure:",
          "required": false,
          "order": 1,
          "options": ["Yes", "No"]
        }
      ]
    }
  ]
}

FIELD PROPERTIES:
- For Multi-Select, Radio Select, Dropdown: add "options": ["Option 1", "Option 2"]
- For Table: add "columns" (header row) and "rowCount" (number of rows)
- For Title: just include the "label" with the title/heading text`;

// ============== UTILITY FUNCTIONS ==============
async function ensureDirectory(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function fileToBase64(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return fileBuffer.toString('base64');
}

async function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try { await fs.unlink(filePath); } catch (e) {}
  }
}

function getFileExtension(filename) {
  return path.extname(filename).toLowerCase().slice(1);
}

function isSupportedFileType(filename) {
  const supportedTypes = ['pdf', 'jpg', 'jpeg', 'png'];
  return supportedTypes.includes(getFileExtension(filename));
}

function extractJsonFromText(text) {
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) return jsonBlockMatch[1].trim();
  const jsonObjectMatch = text.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) return jsonObjectMatch[0];
  return text;
}

function safeJsonParse(str) {
  try {
    return { success: true, data: JSON.parse(str) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============== FILE PROCESSING ==============
async function convertPdfToImages(pdfPath, outputDir) {
  if (!pdfPoppler) {
    throw new Error('PDF processing not available. Install poppler-utils.');
  }

  await ensureDirectory(outputDir);
  const baseName = path.basename(pdfPath, '.pdf');

  await pdfPoppler.convert(pdfPath, {
    format: 'png',
    out_dir: outputDir,
    out_prefix: baseName,
    page: null
  });

  const files = await fs.readdir(outputDir);
  const imageFiles = files
    .filter(f => f.startsWith(baseName) && f.endsWith('.png'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/-(\d+)\.png$/)?.[1] || '0');
      const numB = parseInt(b.match(/-(\d+)\.png$/)?.[1] || '0');
      return numA - numB;
    });

  const images = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const imagePath = path.join(outputDir, imageFiles[i]);
    const base64 = await fileToBase64(imagePath);
    images.push({ page: i + 1, base64, path: imagePath, mimeType: 'image/png' });
  }
  return images;
}

async function processImage(imagePath, outputDir) {
  const baseName = path.basename(imagePath, path.extname(imagePath));
  const outputPath = path.join(outputDir, `${baseName}_processed.png`);

  await sharp(imagePath)
    .png({ quality: 90 })
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .toFile(outputPath);

  const base64 = await fileToBase64(outputPath);
  return [{ page: 1, base64, path: outputPath, mimeType: 'image/png' }];
}

async function processFile(file) {
  const extension = getFileExtension(file.originalname);
  const sessionId = uuidv4();
  const tempDir = path.join(TEMP_DIR, sessionId);

  await ensureDirectory(tempDir);
  const filesToCleanup = [];

  try {
    let images = [];

    if (extension === 'pdf') {
      images = await convertPdfToImages(file.path, tempDir);
    } else if (['jpg', 'jpeg', 'png'].includes(extension)) {
      images = await processImage(file.path, tempDir);
    } else {
      throw new Error(`Unsupported file type: ${extension}`);
    }

    images.forEach(img => { if (img.path) filesToCleanup.push(img.path); });
    filesToCleanup.push(file.path);

    return images.map(img => ({ page: img.page, base64: img.base64, mimeType: img.mimeType }));
  } finally {
    await cleanupFiles(filesToCleanup);
    try { await fs.rmdir(tempDir); } catch (e) {}
  }
}

// ============== OPENAI PROCESSING ==============
async function processImageBatch(images, startPage, totalPages) {
  const content = [
    {
      type: 'text',
      text: totalPages > images.length
        ? `Analyze pages ${startPage} to ${startPage + images.length - 1} of ${totalPages} of this form.`
        : 'Analyze this form and extract its complete structure.'
    }
  ];

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' }
    });
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content }
    ],
    max_tokens: 4096,
    temperature: 0.1
  });

  const responseContent = response.choices[0]?.message?.content;
  if (!responseContent) throw new Error('Empty response from GPT-4o');

  if (responseContent.toLowerCase().includes("i'm sorry") ||
      responseContent.toLowerCase().includes("i cannot")) {
    throw new Error('The AI could not process this document.');
  }

  const jsonString = extractJsonFromText(responseContent);
  const parseResult = safeJsonParse(jsonString);

  if (!parseResult.success) {
    console.error('Failed to parse response:', responseContent);
    throw new Error('Invalid JSON response from AI.');
  }

  return normalizeFormStructure(parseResult.data);
}

function normalizeComponentType(type) {
  if (!type) return 'Short Input';
  const typeMap = {
    'signature': 'Signature', 'multi-select': 'Multi-Select', 'multiselect': 'Multi-Select',
    'checkbox': 'Multi-Select', 'file upload': 'File Upload', 'fileupload': 'File Upload',
    'short input': 'Short Input', 'shortinput': 'Short Input', 'text': 'Short Input',
    'sections': 'Sections', 'section': 'Sections', 'dropdown': 'Dropdown', 'select': 'Dropdown',
    'radio select': 'Radio Select', 'radioselect': 'Radio Select', 'radio': 'Radio Select',
    'table': 'Table', 'title': 'Title', 'heading': 'Title',
    'long input': 'Long Input', 'longinput': 'Long Input', 'textarea': 'Long Input'
  };
  return typeMap[type.toLowerCase()] || type;
}

function normalizeFormStructure(data) {
  const formTitle = data.formTitle || 'Untitled Form';
  const sections = (data.sections || []).map((section, sectionIndex) => ({
    id: section.id || `section_${sectionIndex + 1}`,
    title: section.title || `Section ${sectionIndex + 1}`,
    order: section.order || sectionIndex + 1,
    fields: (section.fields || []).map((field, fieldIndex) => {
      const componentName = normalizeComponentType(field.component || field.type);
      const normalized = {
        id: field.id || `field_${fieldIndex + 1}`,
        component: componentName,
        componentId: COMPONENT_IDS[componentName] || null,
        label: field.label || `Field ${fieldIndex + 1}`,
        required: Boolean(field.required),
        order: field.order || fieldIndex + 1
      };
      if (['Multi-Select', 'Radio Select', 'Dropdown'].includes(normalized.component)) {
        normalized.options = field.options || [];
      }
      if (normalized.component === 'Table') {
        normalized.columns = field.columns || [];
        normalized.rowCount = field.rowCount || 0;
      }
      return normalized;
    })
  }));
  return { formTitle, sections };
}

async function extractFormStructure(images) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  if (!images || images.length === 0) throw new Error('No images provided');

  if (images.length <= MAX_PAGES_PER_BATCH) {
    return await processImageBatch(images, 1, images.length);
  }

  console.log(`Processing ${images.length} pages in batches...`);
  const batchResults = [];

  for (let i = 0; i < images.length; i += MAX_PAGES_PER_BATCH) {
    const batch = images.slice(i, i + MAX_PAGES_PER_BATCH);
    console.log(`Processing pages ${i + 1}-${Math.min(i + MAX_PAGES_PER_BATCH, images.length)}...`);
    batchResults.push(await processImageBatch(batch, i + 1, images.length));
  }

  // Combine results
  const formTitle = batchResults[0].formTitle;
  let sectionOrder = 0;
  const allSections = [];

  for (const result of batchResults) {
    for (const section of result.sections) {
      sectionOrder++;
      allSections.push({
        ...section,
        id: `section_${sectionOrder}`,
        order: sectionOrder,
        fields: section.fields.map((field, idx) => ({ ...field, id: `field_${sectionOrder}_${idx + 1}` }))
      });
    }
  }

  return { formTitle, sections: allSections };
}

// ============== MULTER SETUP ==============
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureDirectory(UPLOADS_DIR);
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    cb(isSupportedFileType(file.originalname) ? null : new Error('Invalid file type'), isSupportedFileType(file.originalname));
  },
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 }
});

// ============== MIDDLEWARE ==============
app.use(cors());
app.use(express.json());

// ============== ROUTES ==============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/extract-form', (req, res, next) => {
  upload.any()(req, res, async (err) => {
    if (err) return next(err);

    const file = req.files?.[0];
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const startTime = Date.now();
    try {
      console.log(`Processing: ${file.originalname} (${file.size} bytes)`);
      const images = await processFile(file);
      console.log(`Converted to ${images.length} image(s), sending to GPT-4o...`);

      const formStructure = await extractFormStructure(images);
      const processingTime = Date.now() - startTime;

      console.log(`Completed in ${processingTime}ms`);
      res.json({
        success: true,
        data: formStructure,
        meta: {
          originalFilename: file.originalname,
          fileSize: file.size,
          pagesProcessed: images.length,
          processingTimeMs: processingTime
        }
      });
    } catch (error) {
      console.error('Error:', error);
      next(error);
    }
  });
});

app.get('/api/supported-types', (req, res) => {
  res.json({
    success: true,
    data: {
      supportedTypes: ['pdf', 'jpg', 'jpeg', 'png'],
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760,
      components: ['Signature', 'Multi-Select', 'File Upload', 'Short Input', 'Sections', 'Dropdown', 'Radio Select', 'Table', 'Title', 'Long Input']
    }
  });
});

// ============== ERROR HANDLING ==============
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: 'File too large' });
  }
  if (err.message === 'Invalid file type') {
    return res.status(400).json({ success: false, error: 'Invalid file type. Use PDF, JPG, or PNG' });
  }
  res.status(500).json({ success: false, error: err.message });
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ============== START SERVER ==============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Form Extractor API running on port ${PORT}`);
  console.log(`POST /api/extract-form - Upload and extract form`);
  console.log(`GET /api/supported-types - Get supported types`);
});

module.exports = app;
