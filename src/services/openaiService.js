const OpenAI = require('openai');
const { extractJsonFromText, safeJsonParse, generateId } = require('../utils/helpers');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Maximum pages to process in a single API call
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

/**
 * System prompt for form structure extraction
 */
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
- Title: Bold text, headings, labels, or instruction text that introduces fields
- Long Input: Multi-line text areas

DOCUMENT STRUCTURE - FLAT (NO SUBSECTIONS):
1. **SECTIONS**: Major sections with headers (highlighted/shaded backgrounds like "III. COVERAGE", "IV. EXPOSURES")
2. **FIELDS**: All items within a section are FIELDS (including titles like "HOSPITALS", "Self-Insured Retention (SIR):")

CRITICAL RULES:
1. **PRESERVE EXACT TEXT**: Copy all labels and titles EXACTLY as they appear in the document. Do NOT rephrase, shorten, summarize, or modify any text.
2. **EXCLUDE SERIAL NUMBERS**: Remove leading numbering/lettering from labels:
   - "A. Does the applicant..." → "Does the applicant..."
   - "III. COVERAGE" → "COVERAGE"
   - "1. Full Name" → "Full Name"
   - "B. Self-Insured Retention (SIR):" → "Self-Insured Retention (SIR):"
   Do NOT include: I., II., III., A., B., 1., 2., (a), (b), etc. at the start.
3. **SKIP INSTRUCTION TEXT**: Do NOT include instruction paragraphs like "Please complete the data below...", "If Yes, provide a copy", guidance text, or any non-input descriptive text. Only capture actual INPUT FIELDS.
4. **DISTINGUISHING TITLE vs INPUT FIELD**:
   - **Title component**: Bold text that stands ALONE on its own line with NO input area (underline, box) on the SAME LINE. The related input fields appear on SEPARATE lines below it. This is a heading/label that groups fields.
     Example: "Self-Insured Retention (SIR):" in bold on its own line, with numbered fields below it = Title component
     Example: "Contact Information:" in bold on its own line = Title component
   - **Input field**: Text where the input area (underline ___, text box, blank space for writing) appears on the SAME LINE as the label.
     Example: "Please identify any change in SIR coverage: ____" = Short Input (input on same line)
     Example: "Full Name: _______________" = Short Input (input on same line)
   - Key visual cue: Is the input area on the SAME LINE as the label? Yes = Input field. No input on same line = Title.
5. Extract ALL visible options for Multi-Select, Radio Select, and Dropdown
6. For Table: extract column headers and COUNT the rows (rowCount)
7. Mark fields as required if they show asterisks (*) or "required"
8. Maintain top-to-bottom, left-to-right ordering
9. **ONLY INPUT FIELDS**: Only capture fields that have actual input areas (text boxes, checkboxes, dropdowns, signature lines, tables). Skip any text that is just instructions or guidance.

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
  Example:
  {
    "component": "Table",
    "label": "Occupied Beds by Type",
    "columns": ["Projected this Year", "Prior Year 1 (Expiring Year)", "Prior Year 2", "Prior Year 3", "Prior Year 4", "Prior Year 5"],
    "rowCount": 12
  }
- For Title: just include the "label" with the title/heading/instruction text

EXAMPLE - Section with various field types:
{
  "id": "section_1",
  "title": "GENERAL INFORMATION",
  "order": 1,
  "fields": [
    {
      "id": "field_1",
      "component": "Short Input",
      "label": "Full Name:",
      "required": true,
      "order": 1
    },
    {
      "id": "field_2",
      "component": "Radio Select",
      "label": "Have you submitted this form before:",
      "options": ["Yes", "No"],
      "order": 2
    },
    {
      "id": "field_3",
      "component": "Long Input",
      "label": "If Yes, please provide details:",
      "order": 3
    },
    {
      "id": "field_4",
      "component": "Title",
      "label": "Contact Information:",
      "order": 4
    },
    {
      "id": "field_5",
      "component": "Dropdown",
      "label": "Preferred contact method:",
      "options": ["Email", "Phone", "Mail"],
      "order": 5
    },
    {
      "id": "field_6",
      "component": "Multi-Select",
      "label": "Select all that apply:",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "order": 6
    }
  ]
}

EXAMPLE - Section with a Table:
{
  "id": "section_2",
  "title": "DATA ENTRY",
  "order": 2,
  "fields": [
    {
      "id": "field_1",
      "component": "Title",
      "label": "ANNUAL SUMMARY",
      "order": 1
    },
    {
      "id": "field_2",
      "component": "Table",
      "label": "Yearly Data",
      "columns": ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5"],
      "rowCount": 5,
      "order": 2
    },
    {
      "id": "field_3",
      "component": "Signature",
      "label": "Authorized Signature:",
      "required": true,
      "order": 3
    },
    {
      "id": "field_4",
      "component": "File Upload",
      "label": "Attach supporting documents:",
      "order": 4
    }
  ]
}`;

/**
 * Extract form structure from images using GPT-4o
 * Processes multi-page documents in batches
 * @param {Array<{page: number, base64: string, mimeType: string}>} images
 * @returns {Promise<Object>} Extracted form structure
 */
async function extractFormStructure(images) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  if (!images || images.length === 0) {
    throw new Error('No images provided for analysis');
  }

  try {
    // For small documents, process all at once
    if (images.length <= MAX_PAGES_PER_BATCH) {
      return await processImageBatch(images, 1, images.length);
    }

    // For larger documents, process in batches and combine
    console.log(`Processing ${images.length} pages in batches of ${MAX_PAGES_PER_BATCH}...`);

    const batchResults = [];
    for (let i = 0; i < images.length; i += MAX_PAGES_PER_BATCH) {
      const batch = images.slice(i, i + MAX_PAGES_PER_BATCH);
      const startPage = i + 1;
      const endPage = Math.min(i + MAX_PAGES_PER_BATCH, images.length);

      console.log(`Processing pages ${startPage}-${endPage}...`);

      const result = await processImageBatch(batch, startPage, images.length);
      batchResults.push(result);
    }

    // Combine all batch results
    return combineResults(batchResults);
  } catch (error) {
    if (error.code === 'insufficient_quota') {
      throw new Error('OpenAI API quota exceeded. Please check your billing.');
    }
    if (error.code === 'invalid_api_key') {
      throw new Error('Invalid OpenAI API key');
    }
    throw error;
  }
}

/**
 * Process a batch of images
 */
async function processImageBatch(images, startPage, totalPages) {
  const content = [
    {
      type: 'text',
      text: totalPages > images.length
        ? `Analyze pages ${startPage} to ${startPage + images.length - 1} of ${totalPages} of this form. Extract all form fields visible on these pages.`
        : 'Analyze this form and extract its complete structure.'
    }
  ];

  // Add images
  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: 'high'
      }
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

  if (!responseContent) {
    throw new Error('Empty response from GPT-4o');
  }

  // Check for refusal
  if (responseContent.toLowerCase().includes("i'm sorry") ||
      responseContent.toLowerCase().includes("i cannot") ||
      responseContent.toLowerCase().includes("i can't")) {
    console.error('GPT-4o refused to process:', responseContent);
    throw new Error('The AI could not process this document. The content may be unclear or restricted. Please try with a clearer image.');
  }

  // Extract JSON from response
  const jsonString = extractJsonFromText(responseContent);
  const parseResult = safeJsonParse(jsonString);

  if (!parseResult.success) {
    console.error('Failed to parse GPT-4o response:', responseContent);
    throw new Error(`Invalid JSON response from AI. Please try again.`);
  }

  return normalizeFormStructure(parseResult.data);
}

/**
 * Combine results from multiple batches
 */
function combineResults(results) {
  if (results.length === 0) {
    return { formTitle: 'Untitled Form', sections: [] };
  }

  if (results.length === 1) {
    return results[0];
  }

  // Use the form title from the first result
  const formTitle = results[0].formTitle || 'Untitled Form';

  // Combine all sections, updating IDs to be unique
  let sectionOrder = 0;
  const allSections = [];

  for (const result of results) {
    for (const section of result.sections || []) {
      sectionOrder++;

      allSections.push({
        ...section,
        id: `section_${sectionOrder}`,
        order: sectionOrder,
        fields: (section.fields || []).map((field, idx) => ({
          ...field,
          id: `field_${sectionOrder}_${idx + 1}`
        }))
      });
    }
  }

  return {
    formTitle,
    sections: allSections
  };
}

/**
 * Normalize a single field
 */
function normalizeField(field, fieldIndex) {
  const componentName = normalizeComponentType(field.component || field.type);
  const normalizedField = {
    id: field.id || generateId('field'),
    component: componentName,
    componentId: COMPONENT_IDS[componentName] || null,
    label: field.label || `Field ${fieldIndex + 1}`,
    required: Boolean(field.required),
    order: field.order || fieldIndex + 1
  };

  if (['Multi-Select', 'Radio Select', 'Dropdown'].includes(normalizedField.component)) {
    normalizedField.options = field.options || [];
  }

  if (normalizedField.component === 'Table') {
    normalizedField.columns = field.columns || [];
    normalizedField.rowCount = field.rowCount || (field.rows ? field.rows.length : 0);
  }

  if (field.placeholder) {
    normalizedField.placeholder = field.placeholder;
  }

  return normalizedField;
}

/**
 * Normalize and validate form structure
 */
function normalizeFormStructure(data) {
  const formTitle = data.formTitle || 'Untitled Form';
  const sections = data.sections || [];

  const normalizedSections = sections.map((section, sectionIndex) => {
    const sectionId = section.id || generateId('section');
    const sectionTitle = section.title || `Section ${sectionIndex + 1}`;
    const fields = section.fields || [];

    // Normalize fields
    const normalizedFields = fields.map((field, fieldIndex) => normalizeField(field, fieldIndex));

    return {
      id: sectionId,
      title: sectionTitle,
      order: section.order || sectionIndex + 1,
      fields: normalizedFields
    };
  });

  return {
    formTitle,
    sections: normalizedSections
  };
}

/**
 * Normalize component type to standard values
 */
function normalizeComponentType(type) {
  if (!type) return 'Short Input';

  const typeMap = {
    'signature': 'Signature',
    'multi-select': 'Multi-Select',
    'multiselect': 'Multi-Select',
    'checkbox': 'Multi-Select',
    'checkboxes': 'Multi-Select',
    'file upload': 'File Upload',
    'fileupload': 'File Upload',
    'file': 'File Upload',
    'attachment': 'File Upload',
    'short input': 'Short Input',
    'shortinput': 'Short Input',
    'text': 'Short Input',
    'textfield': 'Short Input',
    'input': 'Short Input',
    'sections': 'Sections',
    'section': 'Sections',
    'dropdown': 'Dropdown',
    'select': 'Dropdown',
    'radio select': 'Radio Select',
    'radioselect': 'Radio Select',
    'radio': 'Radio Select',
    'table': 'Table',
    'grid': 'Table',
    'title': 'Title',
    'heading': 'Title',
    'header': 'Title',
    'long input': 'Long Input',
    'longinput': 'Long Input',
    'textarea': 'Long Input',
    'multiline': 'Long Input',
    'paragraph': 'Long Input',
    'instruction': 'Title',
    'instructions': 'Title',
    'guidance': 'Title',
    'note': 'Title',
    'info': 'Title'
  };

  const normalized = typeMap[type.toLowerCase()];
  if (normalized) return normalized;

  const validTypes = [
    'Signature', 'Multi-Select', 'File Upload', 'Short Input',
    'Sections', 'Dropdown', 'Radio Select', 'Table', 'Title', 'Long Input'
  ];

  if (validTypes.includes(type)) return type;

  return 'Short Input';
}

module.exports = {
  extractFormStructure,
  normalizeFormStructure,
  normalizeComponentType
};
