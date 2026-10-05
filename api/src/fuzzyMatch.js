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
  topK = 3,
  fuzzyThreshold = 90
) {
  const employees = (roster || []).map(toRosterEmployee);
  if (employees.length === 0) {
    return { match_type: 'none', candidates: [] };
  }

  const normalizedReceiverName = normalizeText(receiverName);
  const normalizedDepartment = normalizeText(department);
  const safeNameWeight = clamp(nameWeight, 0, 1);
  const safeTopK = Math.max(1, Math.floor(topK || 3));
  const safeFuzzyThreshold = clamp(fuzzyThreshold, 0, 100);

  if (normalizedReceiverName.length === 0) {
    return {
      match_type: 'top_k',
      candidates: employees.slice(0, safeTopK).map((employee) =>
        toPublicCandidate({
          ...employee,
          name_score: 0,
          department_score: 0,
          score: 0,
        })
      ),
    };
  }

  const exactNameMatches = employees.filter(
    (employee) => normalizeText(employee.name) === normalizedReceiverName
  );

  if (exactNameMatches.length === 1) {
    return {
      match_type: 'exact_name',
      candidates: [
        toPublicCandidate(
          withDisplayedScore(
            scoreEmployee(
              exactNameMatches[0],
              normalizedReceiverName,
              normalizedDepartment,
              safeNameWeight
            ),
            true
          )
        ),
      ],
    };
  }

  if (exactNameMatches.length >= 2) {
    const exactDepartmentMatches =
      normalizedDepartment.length === 0
        ? []
        : exactNameMatches.filter(
            (employee) =>
              normalizeText(employee.department) === normalizedDepartment
          );

    if (exactDepartmentMatches.length > 0) {
      return {
        match_type: 'exact_name',
        candidates: exactDepartmentMatches.map((employee) =>
          toPublicCandidate(
            withDisplayedScore(
              scoreEmployee(
                employee,
                normalizedReceiverName,
                normalizedDepartment,
                safeNameWeight
              ),
              false
            )
          )
        ),
      };
    }

    const scoredNameMatches = exactNameMatches
      .map((employee) =>
        withDisplayedScore(
          scoreEmployee(employee, normalizedReceiverName, normalizedDepartment, safeNameWeight),
          false
        )
      )
      .sort((a, b) => b.score - a.score);

    return {
      match_type: 'top_k',
      candidates: scoredNameMatches.map(toPublicCandidate),
    };
  }

  const scored = employees.map((employee) =>
    withDisplayedScore(
      scoreEmployee(employee, normalizedReceiverName, normalizedDepartment, safeNameWeight),
      false
    )
  );

  return {
    match_type: 'top_k',
    candidates: pickByFuzzyThreshold(scored, safeFuzzyThreshold, safeTopK).map(toPublicCandidate),
  };
}

function scoreEmployee(employee, normalizedReceiverName, normalizedDepartment, nameWeight) {
  const nameScore = similarity(normalizedReceiverName, normalizeText(employee.name));
  const departmentScore = similarity(normalizedDepartment, normalizeText(employee.department));
  const blendedScore = nameWeight * nameScore + (1 - nameWeight) * departmentScore;
  return toCandidate(employee, nameScore, departmentScore, blendedScore);
}

function withDisplayedScore(candidate, uniqueExactName) {
  const score =
    uniqueExactName && candidate.name_score === 100 ? 100 : candidate.blended_score;
  return { ...candidate, score: round2(score) };
}

function pickByFuzzyThreshold(scored, fuzzyThreshold, topK) {
  const sorted = scored.slice().sort((a, b) => b.score - a.score);
  if (sorted.length === 0) return [];
  if (sorted[0].score > fuzzyThreshold) return [sorted[0]];
  return expandSameNameTopK(sorted, sorted.slice(0, topK));
}

function expandSameNameTopK(sorted, top) {
  if (top.length < 2) return top;

  const sharedName = normalizeText(top[0].name);
  if (!sharedName) return top;

  const allSameName = top.every(
    (candidate) => normalizeText(candidate.name) === sharedName
  );
  if (!allSameName) return top;

  return sorted.filter((candidate) => normalizeText(candidate.name) === sharedName);
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
