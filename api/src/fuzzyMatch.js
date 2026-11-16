/**
 * OCR receiver fuzzy match (ported from Office Script FuzzyMatchEmployees).
 * DB columns full_name / department_name are mapped to name / department so
 * Power Automate Parse JSON can keep the original candidate schema.
 */
function fuzzyMatchEmployees(
  roster,
  receiverName,
  department,
  nameWeight = 0.85,
  minScore = 30
) {
  const employees = (roster || []).map(toRosterEmployee);
  if (employees.length === 0) {
    return { match_type: 'none', candidates: [] };
  }
  const normalizedReceiverName = normalizeText(receiverName);
  const normalizedDepartment = normalizeText(department);
  const safeNameWeight = clamp(nameWeight, 0, 1);
  const safeMinScore = clamp(minScore, 0, 100);
  if (normalizedReceiverName.length === 0) {
    return { match_type: 'none', candidates: [] };
  }
  const exactNameMatches = employees.filter(
    (employee) => normalizeText(employee.name) === normalizedReceiverName
  );
  /* Every exact full-name match, whatever its department: ordered by the
     blended (name + department) score, but each is shown with score 100. */
  if (exactNameMatches.length > 0) {
    return {
      match_type: 'exact_name',
      candidates: exactNameMatches
        .map((employee) =>
          scoreEmployee(employee, normalizedReceiverName, normalizedDepartment, safeNameWeight)
        )
        .sort((a, b) => b.blended_score - a.blended_score)
        .map((candidate) => toPublicCandidate({ ...candidate, score: 100 })),
    };
  }
  /* No exact full name: the OCR name may be the family name only. The family
     name is the part of the DB full name before the first space; names without
     a space have none. score = 60 + department similarity × 0.3. */
  const familyNameMatches = employees.filter((employee) => {
    const family = familyName(employee.name);
    return family !== '' && normalizeText(family) === normalizedReceiverName;
  });
  if (familyNameMatches.length > 0) {
    return {
      match_type: 'family_name',
      candidates: familyNameMatches
        .map((employee) => {
          const candidate = scoreEmployee(
            employee, normalizedReceiverName, normalizedDepartment, safeNameWeight
          );
          const score = Math.min(100, FAMILY_NAME_BASE_SCORE
            + candidate.department_score * FAMILY_NAME_DEPARTMENT_WEIGHT);
          return { ...candidate, score: round2(score) };
        })
        .sort((a, b) => b.score - a.score)
        .map(toPublicCandidate),
    };
  }
  const scored = employees.map((employee) =>
    scoreEmployee(employee, normalizedReceiverName, normalizedDepartment, safeNameWeight)
  );
  return {
    match_type: 'top_k',
    candidates: pickAboveMinScore(scored, safeMinScore).map(toPublicCandidate),
  };
}
const FAMILY_NAME_BASE_SCORE = 60;
const FAMILY_NAME_DEPARTMENT_WEIGHT = 0.3;
/* Part of the full name before the first space (half- or full-width);
   '' when the name has no space, e.g. "竹平 裕紀" -> "竹平", "竹平裕紀" -> "". */
function familyName(fullName) {
  const parts = String(fullName ?? '').normalize('NFKC').trim().split(/\s+/);
  return parts.length >= 2 ? parts[0] : '';
}
function scoreEmployee(employee, normalizedReceiverName, normalizedDepartment, nameWeight) {
  const nameScore = similarity(normalizedReceiverName, normalizeText(employee.name));
  const departmentScore = similarity(normalizedDepartment, normalizeText(employee.department));
  const blendedScore = nameWeight * nameScore + (1 - nameWeight) * departmentScore;
  return toCandidate(employee, nameScore, departmentScore, blendedScore);
}
/* Every candidate scoring above minScore, best first. */
function pickAboveMinScore(scored, minScore) {
  return scored
    .filter((candidate) => candidate.score > minScore)
    .sort((a, b) => b.score - a.score);
}
function toRosterEmployee(row) {
  return {
    employee_id: String(row.employee_id ?? ''),
    name: String(row.full_name ?? row.name ?? ''),
    department: String(row.department_name ?? row.department ?? ''),
    email: String(row.email ?? ''),
  };
}
function toCandidate(employee, nameScore, departmentScore, blendedScore) {
  return {
    employee_id: employee.employee_id,
    name: employee.name,
    department: employee.department,
    email: employee.email,
    name_score: round2(nameScore),
    department_score: round2(departmentScore),
    blended_score: round2(blendedScore),
    score: round2(blendedScore),
  };
}
function toPublicCandidate(row) {
  return {
    employee_id: String(row.employee_id ?? ''),
    name: row.name ?? '',
    department: row.department ?? '',
    email: row.email ?? '',
    name_score: Number(row.name_score ?? 0),
    department_score: Number(row.department_score ?? 0),
    score: Number(row.score ?? 0),
  };
}
function normalizeText(value) {
  const normalizedNumberText = normalizeJapaneseNumber(
    stripInvisibleAndWhitespace(String(value ?? '').normalize('NFKC'))
  );
  return normalizedNumberText
    .toLocaleLowerCase()
    .replace(/[・･.,，。\-‐‑–—_\/\\()[\]（）「」『』【】]/g, '');
}
function stripInvisibleAndWhitespace(text) {
  let result = '';
  for (const char of Array.from(text)) {
    if (char.trim() === '') continue;
    const code = char.charCodeAt(0);
    if (
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      code === 0x2060 ||
      code === 0xfeff
    ) {
      continue;
    }
    result += char;
  }
  return result;
}
function normalizeJapaneseNumber(text) {
  if (!text) return text;
  let normalized = text.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
  normalized = normalized.replace(
    /第([〇零一二三四五六七八九十百千万億兆]+)/g,
    (match, numberText) => {
      const value = parseJapaneseNumber(numberText);
      return value === null ? match : `第${value}`;
    }
  );
  return normalized.replace(/[〇零一二三四五六七八九十百千万億兆]+/g, (match) => {
    if (!isClearlyNumericKanji(match)) return match;
    const value = parseJapaneseNumber(match);
    return value === null ? match : String(value);
  });
}
function isClearlyNumericKanji(text) {
  if (text.length >= 2 && /[十百千万億兆]/.test(text)) return true;
  return text.length >= 2 && /^[〇零一二三四五六七八九]+$/.test(text);
}
function parseJapaneseNumber(text) {
  const digitMap = {
    〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (/^[〇零一二三四五六七八九]+$/.test(text)) {
    return Number(Array.from(text).map((char) => String(digitMap[char])).join(''));
  }
  const smallUnitMap = { 十: 10, 百: 100, 千: 1000 };
  const largeUnitMap = { 万: 10000, 億: 100000000, 兆: 1000000000000 };
  let total = 0;
  let section = 0;
  let current = 0;
  let hasDigit = false;
  let hasUnit = false;
  for (const char of text) {
    if (char in digitMap) {
      current = digitMap[char];
      hasDigit = true;
      continue;
    }
    if (char in smallUnitMap) {
      section += (current === 0 ? 1 : current) * smallUnitMap[char];
      current = 0;
      hasUnit = true;
      continue;
    }
    if (char in largeUnitMap) {
      if (current !== 0) section += current;
      if (section === 0) section = 1;
      total += section * largeUnitMap[char];
      section = 0;
      current = 0;
      hasUnit = true;
      continue;
    }
    return null;
  }
  if (!hasDigit && !hasUnit) return null;
  return total + section + current;
}
function similarity(left, right) {
  if (left === right) return left.length === 0 ? 0 : 100;
  if (left.length === 0 || right.length === 0) return 0;
  const a = Array.from(left);
  const b = Array.from(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost
      );
    }
    for (let j = 0; j < current.length; j++) previous[j] = current[j];
  }
  const distance = previous[b.length];
  const longest = Math.max(a.length, b.length);
  return Math.max(0, (1 - distance / longest) * 100);
}
function clamp(value, min, max) {
  const numericValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, numericValue));
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
module.exports = { fuzzyMatchEmployees, normalizeText };