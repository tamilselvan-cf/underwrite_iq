/**
 * System prompt for form structure extraction
 */
const SYSTEM_PROMPT = `You are an expert form structure analyzer. Your task is to analyze form images and extract their complete structure.

You must identify and classify form fields into these specific components:
1. **Signature** - Signature lines, boxes, or areas where signatures are expected
2. **Multi-Select** - Checkboxes that allow selecting multiple options
3. **File Upload** - Areas designated for file attachments or document uploads
4. **Short Input** - Single-line text input fields (name, email, phone, date, etc.)
5. **Sections** - Section dividers, headers that group related fields
6. **Dropdown** - Select/dropdown fields (even if shown as a box with an arrow)
7. **Radio Select** - Radio buttons allowing single selection from options
8. **Table** - Tabular structures for entering multiple rows of data
9. **Title** - Main form titles, subtitles, or major headings
10. **Long Input** - Multi-line text areas, comment boxes, description fields

IMPORTANT RULES:
- Every field must have exactly ONE component type from the list above
- Extract ALL visible options for Multi-Select, Radio Select, and Dropdown components
- For Table components, extract ALL column headers
- Mark fields as required if they have asterisks (*) or "required" labels
- Maintain the visual order of fields (top to bottom, left to right)
- Group fields logically into sections based on visual layout
- If no clear section exists, create a default "General" section

OUTPUT FORMAT:
Return ONLY valid JSON (no markdown, no explanations) with this exact structure:
{
  "formTitle": "The main title of the form",
  "sections": [
    {
      "id": "section_1",
      "title": "Section Title",
      "order": 1,
      "fields": [
        {
          "id": "field_1",
          "component": "Short Input",
          "label": "Field Label",
          "required": true,
          "order": 1
        }
      ]
    }
  ]
}

Additional field properties based on component type:
- For Multi-Select, Radio Select, Dropdown: add "options": ["Option 1", "Option 2"]
- For Table: add "columns": ["Column 1", "Column 2"]
- For all: include "placeholder" if visible placeholder text exists`;

/**
 * Generate user prompt for single image analysis
 * @param {number} pageNumber - Current page number
 * @param {number} totalPages - Total number of pages
 * @returns {string}
 */
function getUserPrompt(pageNumber = 1, totalPages = 1) {
  if (totalPages === 1) {
    return 'Analyze this form image and extract its complete structure following the specified format.';
  }
  return `Analyze page ${pageNumber} of ${totalPages} of this form. Extract all form fields visible on this page following the specified format.`;
}

/**
 * Generate prompt for combining multi-page results
 */
const COMBINE_PAGES_PROMPT = `You are given form structure data from multiple pages of the same form.
Combine them into a single cohesive form structure.

Rules:
- Merge sections that span across pages
- Maintain correct ordering of all fields
- Remove any duplicate fields
- Keep the main form title from page 1
- Ensure all IDs are unique

Return ONLY valid JSON with the combined structure.`;

/**
 * Build the complete messages array for OpenAI API
 * @param {Array<{base64: string, mimeType: string}>} images - Array of images
 * @returns {Array} Messages array for OpenAI API
 */
function buildMessages(images) {
  const messages = [
    {
      role: 'system',
      content: SYSTEM_PROMPT
    }
  ];

  if (images.length === 1) {
    // Single image
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: getUserPrompt(1, 1)
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${images[0].mimeType};base64,${images[0].base64}`,
            detail: 'high'
          }
        }
      ]
    });
  } else {
    // Multiple images - send all at once
    const content = [
      {
        type: 'text',
        text: `Analyze this ${images.length}-page form and extract its complete structure. Combine all pages into a single cohesive form structure.`
      }
    ];

    images.forEach((img, index) => {
      content.push({
        type: 'text',
        text: `Page ${index + 1}:`
      });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.base64}`,
          detail: 'high'
        }
      });
    });

    messages.push({
      role: 'user',
      content
    });
  }

  return messages;
}

module.exports = {
  SYSTEM_PROMPT,
  COMBINE_PAGES_PROMPT,
  getUserPrompt,
  buildMessages
};
