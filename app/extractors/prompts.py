"""Prompts. Both extractors ask for the same JSON keys, so their outputs merge."""

from __future__ import annotations

OUTPUT_CONTRACT = """\
Return ONLY a JSON object with exactly these keys:
  is_package_label (boolean)
  receiver_name    (string)
  department       (string)
  client_info      (string)
  tracking_number  (string)
  item             (string)
  confidence       (number between 0.0 and 1.0)

Rules:
- is_package_label: true for a delivery slip / shipping label (Yamato, Sagawa,
  Seino, ...); false for a receipt, business card, or an unrelated photo. When
  false, leave the other string fields empty.
- receiver_name: the recipient's personal name only (お届け先). Strip honorifics
  (様, 殿, さん). Never include a department, company, address, phone or title.
- department: the recipient's department / unit ONLY - short, e.g. 営業部, 開発部,
  第一事業部, EDS本社, or a short latin unit such as "Exeo Dig. Sol.".
  Take it from the same line as the name or the line immediately above/below.
  Do NOT concatenate company name + department + address. Do NOT take the
  department from the sender (ご依頼主) block. Empty string if absent.
- "name(department)" often prints as one string: split it. `清原 彬(Exeo Dig. Sol.)`
  -> receiver_name `清原 彬`, department `Exeo Dig. Sol.`
- client_info: sender (ご依頼主) company or person.
- tracking_number: お問い合わせ番号 / tracking number; the main one if several.
- item: 品名 / 内容品.
- confidence: your own confidence in the whole extraction. Lower it when the
  image is unclear or you had to guess. Always a number, never a string.
- Never invent values that are not visible. Use "" instead.
- Output nothing except the JSON object.
"""

VISION_PROMPT = (
    "You read Japanese delivery slips / package labels from an image.\n\n"
    + OUTPUT_CONTRACT
)

TEXT_PROMPT_TEMPLATE = (
    "Below is raw OCR text from a Japanese delivery slip / package label.\n"
    "Line order and spacing may be unreliable.\n\n"
    + OUTPUT_CONTRACT
    + "\n--- OCR TEXT ---\n{ocr_text}\n--- END OCR TEXT ---\n"
)
