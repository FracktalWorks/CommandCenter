"use strict";
/**
 * Pure, dependency-free intelligence helpers shared by the backend service and
 * the browser UI. Keeping these self-contained (no Node, Theia or DOM imports)
 * makes them deterministic and trivially unit-testable.
 *
 * Three capabilities live here, inspired by the self-hosted AI-workspace
 * pattern sources (Odysseus, Mission Control) catalogued in
 * `ai-company-brain/references.md`:
 *
 *  1. {@link selectDirectivesForPrompt} — relevance-ranked, capped directive
 *     selection so an agent's compiled prompt stays lean as directives grow.
 *  2. {@link scanSkillContent} — static security scan of a SKILL.md body for
 *     prompt-injection, credential leaks, exfiltration and dangerous shell.
 *  3. {@link computeTrustScore} — a recency-weighted 0-100 trust score derived
 *     from an agent's thumbs up/down feedback log.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeTrustScore = exports.scanSkillContent = exports.selectDirectivesForPrompt = exports.DEFAULT_DIRECTIVE_CAP = void 0;
// ---------------------------------------------------------------------------
// 1. Relevance-ranked directive selection
// ---------------------------------------------------------------------------
/** Default maximum number of active directives compiled into a prompt. */
exports.DEFAULT_DIRECTIVE_CAP = 16;
/** Extract lowercase word tokens (length ≥ 3) from arbitrary text. */
function tokenize(text) {
    var _a;
    return ((_a = text.toLowerCase().match(/[a-z0-9]{3,}/g)) !== null && _a !== void 0 ? _a : []);
}
/**
 * Score one directive against the agent context. Combines three signals:
 *  - evalScore (0..1) when present — directives proven by evals rank higher;
 *  - recency — newer directives rank higher (recency given as a 0..1 rank);
 *  - keyword overlap with the agent's soul/description — topical relevance.
 */
function scoreDirective(directive, contextTokens, recencyRank) {
    const evalSignal = typeof directive.evalScore === 'number' ? directive.evalScore : 0.5;
    const dirTokens = tokenize(directive.text);
    let overlap = 0;
    for (const t of dirTokens) {
        if (contextTokens.has(t)) {
            overlap++;
        }
    }
    const overlapSignal = dirTokens.length ? Math.min(1, overlap / Math.max(3, dirTokens.length / 2)) : 0;
    // Weighted blend. Eval evidence dominates, then topical relevance, then recency.
    return evalSignal * 0.5 + overlapSignal * 0.3 + recencyRank * 0.2;
}
/**
 * Select and rank the active directives to compile into an agent prompt,
 * capping the total so prompts stay lean as directives accumulate. Returns the
 * chosen directives (highest priority first) and the number omitted.
 *
 * The selection is deterministic: no embeddings or external calls, just a
 * keyword/eval/recency blend. When the active set fits under the cap, all are
 * returned (still ranked) and `omittedCount` is 0.
 */
function selectDirectivesForPrompt(directives, context = {}, cap = exports.DEFAULT_DIRECTIVE_CAP) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const active = directives.filter(d => d.status === 'active');
    if (active.length === 0) {
        return { selected: [], omittedCount: 0 };
    }
    const contextTokens = new Set([
        ...tokenize((_b = (_a = context.soul) === null || _a === void 0 ? void 0 : _a.role) !== null && _b !== void 0 ? _b : ''),
        ...tokenize((_d = (_c = context.soul) === null || _c === void 0 ? void 0 : _c.domain) !== null && _d !== void 0 ? _d : ''),
        ...tokenize((_f = (_e = context.soul) === null || _e === void 0 ? void 0 : _e.persona) !== null && _f !== void 0 ? _f : ''),
        ...tokenize(((_h = (_g = context.soul) === null || _g === void 0 ? void 0 : _g.coreValues) !== null && _h !== void 0 ? _h : []).join(' ')),
        ...tokenize((_j = context.description) !== null && _j !== void 0 ? _j : ''),
    ]);
    // Recency rank: oldest = 0, newest = 1 (stable when timestamps collide).
    const byAge = [...active].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    const recencyRank = new Map();
    byAge.forEach((d, i) => {
        recencyRank.set(d.id, active.length === 1 ? 1 : i / (active.length - 1));
    });
    const ranked = [...active].sort((a, b) => {
        var _a, _b;
        const sa = scoreDirective(a, contextTokens, (_a = recencyRank.get(a.id)) !== null && _a !== void 0 ? _a : 0);
        const sb = scoreDirective(b, contextTokens, (_b = recencyRank.get(b.id)) !== null && _b !== void 0 ? _b : 0);
        if (sb !== sa) {
            return sb - sa;
        }
        // Tie-break: newer first for stability.
        return b.addedAt.localeCompare(a.addedAt);
    });
    if (ranked.length <= cap) {
        return { selected: ranked, omittedCount: 0 };
    }
    return { selected: ranked.slice(0, cap), omittedCount: ranked.length - cap };
}
exports.selectDirectivesForPrompt = selectDirectivesForPrompt;
/**
 * Static detection rules. Each is intentionally conservative — favouring a
 * small false-positive rate over missing genuinely dangerous content. These do
 * NOT execute anything; they only pattern-match the skill text.
 */
const SCAN_RULES = [
    // --- Prompt injection / jailbreak ---
    {
        severity: 'high', category: 'injection',
        message: 'Prompt-injection attempt: instructs the agent to ignore prior instructions.',
        pattern: /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|directions|prompts|rules)/i,
    },
    {
        severity: 'high', category: 'injection',
        message: 'Prompt-injection attempt: instructs the agent to disregard its system prompt.',
        pattern: /disregard\s+(the\s+|your\s+)?(system|previous|above|safety)\b/i,
    },
    {
        severity: 'high', category: 'injection',
        message: 'Attempts to exfiltrate or reveal the agent\'s hidden system prompt.',
        pattern: /(reveal|print|repeat|show|output)\s+(your\s+|the\s+)?(system\s+|hidden\s+|initial\s+)?(prompt|instructions)/i,
    },
    {
        severity: 'medium', category: 'injection',
        message: 'Possible jailbreak persona switch ("you are now…" / "DAN mode").',
        pattern: /(you\s+are\s+now\s+(a|an|in)\b|\bDAN\s+mode\b|developer\s+mode\s+enabled)/i,
    },
    // --- Credential leakage ---
    {
        severity: 'critical', category: 'credential',
        message: 'Hard-coded private key embedded in the skill.',
        pattern: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|DSA\s+|PGP\s+)?PRIVATE KEY-----/,
    },
    {
        severity: 'critical', category: 'credential',
        message: 'Hard-coded AWS access key id.',
        pattern: /\bAKIA[0-9A-Z]{16}\b/,
    },
    {
        severity: 'high', category: 'credential',
        message: 'Hard-coded API token (OpenAI/GitHub/Slack-style).',
        pattern: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    },
    {
        severity: 'medium', category: 'credential',
        message: 'Inline secret assignment (api key / token / password set to a literal).',
        pattern: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    },
    // --- Data exfiltration ---
    {
        severity: 'high', category: 'exfiltration',
        message: 'Sends data to a known ephemeral exfiltration endpoint.',
        pattern: /\b(webhook\.site|requestbin|pipedream\.net|ngrok\.io|burpcollaborator|oast\.(?:pro|live|site|fun)|interact\.sh|pastebin\.com\/api)\b/i,
    },
    {
        severity: 'high', category: 'exfiltration',
        message: 'Pipes a secret/environment value into a network request.',
        pattern: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*(\$(\{)?[A-Z_]{3,}|process\.env|os\.environ|printenv|\benv\b)/i,
    },
    {
        severity: 'high', category: 'exfiltration',
        message: 'Reverse shell or raw socket data exfiltration (nc -e / bash /dev/tcp).',
        pattern: /(\bnc\b[^\n]*-e\b|\/dev\/tcp\/|bash\s+-i\s+>&)/i,
    },
    // --- Dangerous shell ---
    {
        severity: 'critical', category: 'shell',
        message: 'Destructive recursive delete of a root / home path.',
        pattern: /\brm\s+-rf?\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|\.\s*$)/,
    },
    {
        severity: 'critical', category: 'shell',
        message: 'Fork bomb.',
        pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    },
    {
        severity: 'high', category: 'shell',
        message: 'Pipes a downloaded script straight into a shell (curl|bash).',
        pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
    },
    {
        severity: 'high', category: 'shell',
        message: 'Overwrites a raw block device (dd to /dev/sd*) or formats a filesystem.',
        pattern: /(\bdd\b[^\n]*of=\/dev\/(sd|hd|nvme|mmcblk)|\bmkfs(\.\w+)?\b\s+\/dev\/)/i,
    },
    {
        severity: 'medium', category: 'shell',
        message: 'Loosens file permissions to world-writable/executable (chmod 777).',
        pattern: /\bchmod\s+(-R\s+)?0?777\b/,
    },
    // --- Obfuscation ---
    {
        severity: 'high', category: 'obfuscation',
        message: 'Decodes and executes obfuscated content (eval of base64/hex).',
        pattern: /(eval\s*\(\s*(atob|Buffer\.from|base64)|base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh)/i,
    },
    {
        severity: 'low', category: 'obfuscation',
        message: 'Large embedded base64 blob — review what it decodes to.',
        pattern: /[A-Za-z0-9+/]{160,}={0,2}/,
    },
];
/** Per-severity penalty applied to the 100-point safety score. */
const SEVERITY_PENALTY = {
    critical: 55,
    high: 25,
    medium: 10,
    low: 3,
};
/**
 * Statically scan a skill's Markdown body for unsafe content. Returns all
 * findings with severities, an aggregate 0-100 safety score, and an `ok` flag
 * (true only when no critical/high issues are present). Purely pattern-based —
 * nothing in the content is executed.
 */
function scanSkillContent(content) {
    const findings = [];
    const lines = content.split(/\r?\n/);
    for (const rule of SCAN_RULES) {
        // Find the first matching line so we can report a location.
        let matchedLine;
        let snippet;
        for (let i = 0; i < lines.length; i++) {
            const m = rule.pattern.exec(lines[i]);
            if (m) {
                matchedLine = i + 1;
                snippet = m[0].slice(0, 120);
                break;
            }
        }
        if (matchedLine !== undefined) {
            findings.push({
                severity: rule.severity,
                category: rule.category,
                message: rule.message,
                line: matchedLine,
                snippet,
            });
        }
    }
    let score = 100;
    for (const f of findings) {
        score -= SEVERITY_PENALTY[f.severity];
    }
    score = Math.max(0, Math.min(100, score));
    const ok = !findings.some(f => f.severity === 'critical' || f.severity === 'high');
    // Order findings by severity (critical first) for display.
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return { ok, score, findings };
}
exports.scanSkillContent = scanSkillContent;
function bandFor(score, total) {
    if (total === 0) {
        return 'unrated';
    }
    if (score >= 85) {
        return 'excellent';
    }
    if (score >= 70) {
        return 'good';
    }
    if (score >= 50) {
        return 'fair';
    }
    return 'poor';
}
/**
 * Compute a recency-weighted 0-100 trust score from an agent's feedback log.
 * Newer feedback counts up to ~2x a baseline weight, so an agent that recently
 * improved recovers its reputation without erasing history. With no feedback,
 * returns a neutral score of 50 and the `unrated` band.
 */
function computeTrustScore(feedback) {
    const total = feedback.length;
    const positive = feedback.filter(f => f.signal === 'positive').length;
    const negative = total - positive;
    if (total === 0) {
        return { score: 50, band: 'unrated', total: 0, positive: 0, negative: 0, weightedPositiveRatio: 0 };
    }
    // Sort oldest → newest so newer entries get a larger recency weight.
    const ordered = [...feedback].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let weightedPositive = 0;
    let weightedTotal = 0;
    ordered.forEach((f, i) => {
        // Weight ramps linearly from 1.0 (oldest) to 2.0 (newest).
        const w = total === 1 ? 1 : 1 + i / (total - 1);
        weightedTotal += w;
        if (f.signal === 'positive') {
            weightedPositive += w;
        }
    });
    const weightedPositiveRatio = weightedTotal ? weightedPositive / weightedTotal : 0;
    const score = Math.round(weightedPositiveRatio * 100);
    return { score, band: bandFor(score, total), total, positive, negative, weightedPositiveRatio };
}
exports.computeTrustScore = computeTrustScore;
//# sourceMappingURL=agent-intelligence.js.map