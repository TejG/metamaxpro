// Resume section parser — extracts structured sections from plain text resume.
//
// Handles both standard headings (Experience, Skills, Education) and non-standard
// variations (Work History, Technical Skills, etc.). Falls back to heuristics if
// no clear section markers exist.

/**
 * Parse a resume into sections.
 * @param {string} resumeText - Raw resume text
 * @returns {Object} Sections object: { experience, skills, projects, education, summary, other }
 */
function parseResumeSections(resumeText) {
    if (!resumeText || typeof resumeText !== 'string') {
        return {
            experience: '',
            skills: '',
            projects: '',
            education: '',
            summary: '',
            other: resumeText || '',
        };
    }

    const text = resumeText.trim();
    const lines = text.split('\n');

    // Section markers (case-insensitive, flexible matching)
    // Must be the ONLY text on the line (or with minimal trailing like ":")
    const sectionPatterns = {
        summary: /^(summary|profile|objective|about|professional summary|overview)\s*:?\s*$/i,
        experience: /^(experience|work history|employment|professional experience|work experience|career|positions held|professional background)\s*:?\s*$/i,
        skills: /^(skills|technical skills|core competencies|expertise|proficiencies|technologies|tools)\s*:?\s*$/i,
        projects: /^(projects|key projects|notable projects|select projects|portfolio)\s*:?\s*$/i,
        education: /^(education|academic background|degrees|qualifications|training|academic qualifications)\s*:?\s*$/i,
    };

    const sections = {
        experience: [],
        skills: [],
        projects: [],
        education: [],
        summary: [],
        other: [],
    };

    let currentSection = 'other';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if this line is a section header
        let matched = false;
        for (const [sectionName, pattern] of Object.entries(sectionPatterns)) {
            if (pattern.test(trimmed)) {
                currentSection = sectionName;
                matched = true;
                break;
            }
        }

        // If not a header, accumulate into current section
        if (!matched) {
            sections[currentSection].push(line);
        }
    }

    // Convert arrays to strings
    const result = {};
    for (const [key, lines] of Object.entries(sections)) {
        result[key] = lines.join('\n').trim();
    }

    // If no sections detected (entire resume in 'other'), attempt heuristic split
    if (!result.experience && !result.skills && !result.education && result.other) {
        return heuristicSectionSplit(result.other);
    }

    return result;
}

/**
 * Heuristic section extraction when no clear headers exist.
 * Uses content patterns to guess sections.
 */
function heuristicSectionSplit(text) {
    const lines = text.split('\n');
    const sections = {
        experience: [],
        skills: [],
        projects: [],
        education: [],
        summary: [],
        other: [],
    };

    let inExperience = false;
    let inSkills = false;
    let inEducation = false;

    for (const line of lines) {
        const lower = line.toLowerCase();

        // Heuristics for experience (job titles, companies, dates)
        if (/\b(engineer|developer|manager|analyst|consultant|designer|lead|senior|junior|intern)\b/i.test(line) && /\b\d{4}\b/.test(line)) {
            inExperience = true;
            inSkills = false;
            inEducation = false;
        }

        // Heuristics for skills (comma-separated tech terms)
        if (/\b(javascript|python|java|react|node|aws|sql|api|docker|kubernetes|git|typescript|html|css)\b/i.test(lower) && /,/.test(line)) {
            inSkills = true;
            inExperience = false;
            inEducation = false;
        }

        // Heuristics for education (university, degree, GPA)
        if (/\b(university|college|bachelor|master|phd|degree|gpa|graduated)\b/i.test(lower)) {
            inEducation = true;
            inExperience = false;
            inSkills = false;
        }

        // Accumulate
        if (inExperience) sections.experience.push(line);
        else if (inSkills) sections.skills.push(line);
        else if (inEducation) sections.education.push(line);
        else sections.other.push(line);
    }

    return {
        experience: sections.experience.join('\n').trim(),
        skills: sections.skills.join('\n').trim(),
        projects: sections.projects.join('\n').trim(),
        education: sections.education.join('\n').trim(),
        summary: sections.summary.join('\n').trim(),
        other: sections.other.join('\n').trim(),
    };
}

/**
 * Get a compact summary of which sections have content.
 * Useful for logging/debugging.
 */
function getSectionSummary(sections) {
    const summary = {};
    for (const [key, text] of Object.entries(sections)) {
        summary[key] = text ? `${text.length} chars` : 'empty';
    }
    return summary;
}

module.exports = {
    parseResumeSections,
    getSectionSummary,
};
