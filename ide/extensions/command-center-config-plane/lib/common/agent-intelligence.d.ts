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
interface DirectiveLike {
    id: string;
    status: string;
    text: string;
    evalScore?: number;
    addedAt: string;
}
interface FeedbackLike {
    signal: 'positive' | 'negative';
    createdAt: string;
}
interface SoulLike {
    role?: string;
    domain?: string;
    persona?: string;
    coreValues?: string[];
}
/** Default maximum number of active directives compiled into a prompt. */
export declare const DEFAULT_DIRECTIVE_CAP = 16;
/** Context used to rank directives by relevance to an agent. */
export interface DirectiveContext {
    soul?: SoulLike;
    description?: string;
}
/** Outcome of {@link selectDirectivesForPrompt}. */
export interface DirectiveSelection<D extends DirectiveLike = DirectiveLike> {
    /** Directives to compile into the prompt, ordered by descending priority. */
    selected: D[];
    /** Count of active directives dropped because the cap was exceeded. */
    omittedCount: number;
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
export declare function selectDirectivesForPrompt<D extends DirectiveLike>(directives: D[], context?: DirectiveContext, cap?: number): DirectiveSelection<D>;
export type SkillScanSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SkillScanCategory = 'injection' | 'credential' | 'exfiltration' | 'shell' | 'obfuscation';
/** One issue discovered by {@link scanSkillContent}. */
export interface SkillScanFinding {
    severity: SkillScanSeverity;
    category: SkillScanCategory;
    /** Human-readable explanation of the risk. */
    message: string;
    /** 1-based line number where the pattern matched, if known. */
    line?: number;
    /** The matched text, truncated for display. */
    snippet?: string;
}
/** Aggregate result of scanning a skill body. */
export interface SkillScanResult {
    /** True when there are no critical or high-severity findings. */
    ok: boolean;
    /** Safety score 0 (dangerous) .. 100 (clean). */
    score: number;
    findings: SkillScanFinding[];
}
/**
 * Statically scan a skill's Markdown body for unsafe content. Returns all
 * findings with severities, an aggregate 0-100 safety score, and an `ok` flag
 * (true only when no critical/high issues are present). Purely pattern-based —
 * nothing in the content is executed.
 */
export declare function scanSkillContent(content: string): SkillScanResult;
/** Trust band derived from the numeric score. */
export type TrustBand = 'unrated' | 'poor' | 'fair' | 'good' | 'excellent';
/** Recency-weighted reputation derived from an agent's feedback log. */
export interface TrustScore {
    /** 0-100 score. 50 is neutral; returned as the score when unrated. */
    score: number;
    band: TrustBand;
    total: number;
    positive: number;
    negative: number;
    /** Weighted positive ratio (0..1) the score is derived from. */
    weightedPositiveRatio: number;
}
/**
 * Compute a recency-weighted 0-100 trust score from an agent's feedback log.
 * Newer feedback counts up to ~2x a baseline weight, so an agent that recently
 * improved recovers its reputation without erasing history. With no feedback,
 * returns a neutral score of 50 and the `unrated` band.
 */
export declare function computeTrustScore(feedback: FeedbackLike[]): TrustScore;
export {};
