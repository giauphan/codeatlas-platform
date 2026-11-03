import type { MemoryCertainty, MemoryKind, SourceRole, StructuredMemory } from './structuredMemoryExtractor.js';

export type Classification = { kind: MemoryKind; certainty: MemoryCertainty; confidence: number } | null;

export function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const SYNTHETIC_ENGLISH_MARKER_RE = /\b(?:synthetic|fake|test|testing|temporary|redaction check)\b/iu;
const SYNTHETIC_ENGLISH_SECRET_RE = /\b(?:credential|secret|token|api_key|api-key|apikey|aws_key|aws-key|awskey)\b/iu;
const SYNTHETIC_ENGLISH_GUARD_RE = /\b(?:do not|don't|never|not real|no value|redact|redaction)\b/iu;
const SYNTHETIC_VI_SECRET_RE = /(?:dữ liệu giả|mật khẩu giả|token giả|khóa giả|khóa bí mật giả)/iu;
const SYNTHETIC_VI_CHECK_RE = /(?:kiểm thử|kiểm tra|password|token|secret|api_key|api-key|apikey)/iu;

function syntheticRedactionOnly(text: string): boolean {
  const sentences = text.split(/[.!?;]+/);
  return sentences.some((clause) => {
    const enMatch =
      SYNTHETIC_ENGLISH_MARKER_RE.test(clause) &&
      SYNTHETIC_ENGLISH_SECRET_RE.test(clause) &&
      SYNTHETIC_ENGLISH_GUARD_RE.test(clause);
    const viMatch = SYNTHETIC_VI_SECRET_RE.test(clause) && SYNTHETIC_VI_CHECK_RE.test(clause);
    return enMatch || viMatch;
  });
}

const REVIEW_PROMISE_PREFIX_RE = /^(?:(?:thanks|thank you)[,.!\s]*)*(?:i'll|i will|we'll|we will)\s+(?:review|look over|look at|check|read)\b/iu;
const REVIEW_PROMISE_TIMING_RE = /\b(?:tomorrow|later|next week|next month|when i can|when we can)\b[.!?\s]*$/iu;

function reviewPromise(text: string): boolean {
  const trimmed = text.trim().replace(/[.!?\s]+$/u, '');
  const withoutPrefix = trimmed.replace(/^(?:(?:thanks|thank you)[,.!\s]*)+/iu, '');
  return !/[.!?]/u.test(withoutPrefix) && REVIEW_PROMISE_PREFIX_RE.test(trimmed) && REVIEW_PROMISE_TIMING_RE.test(text.trim());
}

const SMALL_TALK_PHRASE_RE = /^(?:thanks for the chat|thanks for chat|thank you for the chat|thank you for chat|thanks|thank you|enjoy the weekend|good morning|weather|sunny)$/iu;

function isSmallTalkOnly(normalized: string): boolean {
  const tokens = normalized.split(/[,.!\s]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const clauses = normalized.split(/[,.!]+/).map((c) => c.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((c) => SMALL_TALK_PHRASE_RE.test(c));
}

export function nonMemoryText(text: string): boolean {
  const normalized = text.trim();
  const smallTalkOnly = isSmallTalkOnly(normalized);
  const checkpointTransportMarker = /^Session checkpoint\s+\((?:Stop|PreCompact)\)$/iu.test(normalized);
  return normalized.length < 20 || smallTalkOnly || (syntheticRedactionOnly(normalized) && !observedFailure(normalized)) || reviewPromise(normalized) || checkpointTransportMarker;
}

const UNRESOLVED_STATE_PATTERNS = [
  /\b(?:have not decided whether|haven't decided whether|only a guess|just a guess|merely a guess)\b/iu,
  /\b(?:do not have|don't have) (?:the )?(?:trace|traces|evidence|log|logs)\b/iu,
  /\b(?:not sure|unclear whether|unknown whether|could not find|can't find|cannot find)\b/iu,
  /\bno (?:compatibility )?(?:policy|answer|documentation)\b/iu,
  /\b(?:has not confirmed|haven't confirmed|have not confirmed|not yet confirmed)\b/iu,
  /(?:chưa tìm thấy|không tìm thấy|chưa xác nhận|chưa rõ|không rõ|chưa biết|chỉ suy đoán|chỉ là suy đoán)/iu,
  /chưa có[^.!?;]{0,50}(?:dấu vết|bằng chứng|nhật ký)/iu,
];

const UNRESOLVED_INTERROGATIVE_PATTERNS = [
  /^(?:could|should|would|might|can)\s+(?:the|this|that|we|our|these|those)\b[\s\S]{0,260}\?/iu,
  /^(?:liệu|có nên|chúng ta có nên)[\s\S]{0,260}\?/iu,
];

export function unresolvedQuestionWithContext(text: string): boolean {
  const trimmed = text.trim();
  return containsAny(text, UNRESOLVED_STATE_PATTERNS) || containsAny(trimmed, UNRESOLVED_INTERROGATIVE_PATTERNS);
}

const WORKFLOW_TOPIC_PATTERNS = [
  /\b(?:commit|commits|commit subject|commit message|pull request|pull requests|prs)\b/iu,
  /\b(?:repro step|repro steps|reproduction step|reproduction steps|test guide|test guides|run instruction|run instructions)\b/iu,
  /\b(?:example|examples|review|reviews|handoff note|handoff notes|branch name|branch names|repository|repo)\b/iu,
  /\b(?:deployment example|deployment examples|typescript|javascript|node test runner|test runner|package manager|tooling|workflow)\b/iu,
  /(?:ghi chú commit|bước tái hiện|hướng dẫn chạy thử|ví dụ|đánh giá|ghi chú bàn giao|tên nhánh|kho mã)/iu,
];

const WORKFLOW_CLAUSE_EN_RE = /\b(?:when|if|for|while|in)\b[^.!?]{0,140}\b(?:you|i|we|suggest|propose|write|show|showing|local|repro|review|example|examples|guide|step|steps|repository|repo|command|commands|typescript|javascript|node|test runner|package manager|workflow)\b/iu;
const WORKFLOW_CLAUSE_VI_RE = /(?:khi|nếu|với|trong)[^.!?]{0,140}(?:hãy|nên|muốn|thích|giả sử|dùng|nêu|ghi|đề xuất|ví dụ|hướng dẫn|kho mã)/iu;

export function workflowPreference(text: string): boolean {
  const workflowTopic = containsAny(text, WORKFLOW_TOPIC_PATTERNS);
  if (!workflowTopic) return false;
  return (
    WORKFLOW_CLAUSE_EN_RE.test(text) ||
    WORKFLOW_CLAUSE_VI_RE.test(text) ||
    /^(?:please\s+)?(?:keep|use|prefer|run|write|show|choose)\b/iu.test(text)
  );
}

const COMMIT_NOUN_PATTERNS = [
  /\b(?:commit|commits|patch|patches|changeset|changesets|pull request|pull requests|pr|prs)\b/iu,
  /\b(?:merge request|merge requests|revision history|branch history)\b/iu,
  /(?:bản\s+vá|lịch sử commit|yêu cầu hợp nhất)/iu,
];

const ENGLISH_COMMIT_DIRECTIVE_PREFIX_RE = /^(?:(?:for|during|in)\s+[^.!?]{1,80},\s*)?(?:please\s+)?/iu;
const ENGLISH_COMMIT_DIRECTIVE_VERB_RE = /^(?:keep|preserve|retain|leave|show|present|split|separate|group|squash|combine|collapse|order|arrange)\b/iu;
const ENGLISH_COMMIT_PREF_RE = /\b(?:i|we)\s+(?:(?:usually|generally|always|typically|now)\s+)?(?:prefer|want|like)\b/iu;
const ENGLISH_COMMIT_UPDATE_PAST_RE = /\b(?:i|we)\s+(?:used to|previously|formerly)\s+(?:prefer|want|like)\b/iu;
const ENGLISH_COMMIT_UPDATE_NOW_RE = /\b(?:but|however|now|starting)\b[^.!?]{0,120}\b(?:preserve|retain|keep|squash|combine|separate)\b/iu;
const VIETNAMESE_COMMIT_DIRECTIVE_PREFIX_RE = /^(?:(?:trong|ở|với)\s+[^.!?]{1,80},\s*)?(?:(?:hãy|vui lòng|nên|cần|vẫn)\s+)?/iu;
const VIETNAMESE_COMMIT_DIRECTIVE_VERB_RE = /^(?:giữ riêng|tách riêng|gộp|gom|squash|giữ lại|trình bày riêng)/iu;
const VIETNAMESE_ORDERING_CONTEXT_RE = /(?:trong|ở)\s+(?:bản\s+)?(?:tổng kết|báo cáo|đánh giá|ví dụ|hướng dẫn|ghi chú phát hành)/iu;
const VIETNAMESE_ORDERING_ACTION_RE = /(?:liệt kê|hiển thị|sắp xếp|đặt|trình bày|xếp|đưa)[^.!?]{0,100}(?:trước|sau|đầu|cuối|theo thứ tự)/iu;

export function presentationPreference(text: string): boolean {
  const reviewContext = /\b(?:in|for)\b[^.!?]{0,80}\b(?:review|reviews|report|reports|summaries|examples|release notes)\b/iu.test(text);
  const orderingDirective = /\b(?:list|show|put|place|order|sort|present|display)\b[^.!?]{0,120}\b(?:before|after|first|last)\b/iu.test(text) &&
    /\b(?:commit|diff|review|report|summary|example|staging|production|format|section|table|log|logs)\b/iu.test(text);
  const exampleDirective = /\bin (?:deployment|code|review|release|documentation|cli) examples\b/iu.test(text) &&
    /\b(?:use|show|include|keep|leave|avoid|present)\b[^.!?]{0,100}\b(?:staging|production|format|section|table|log|logs|example)\b/iu.test(text);
  const commitNoun = containsAny(text, COMMIT_NOUN_PATTERNS);
  const englishCommitDirective = ENGLISH_COMMIT_DIRECTIVE_VERB_RE.test(text.replace(ENGLISH_COMMIT_DIRECTIVE_PREFIX_RE, ''));
  const englishCommitPreference = ENGLISH_COMMIT_PREF_RE.test(text);
  const englishCommitUpdate = ENGLISH_COMMIT_UPDATE_PAST_RE.test(text) && ENGLISH_COMMIT_UPDATE_NOW_RE.test(text);
  const vietnameseCommitDirective = VIETNAMESE_COMMIT_DIRECTIVE_VERB_RE.test(text.replace(VIETNAMESE_COMMIT_DIRECTIVE_PREFIX_RE, ''));
  const commitLayout = commitNoun && (englishCommitDirective || englishCommitPreference || englishCommitUpdate || vietnameseCommitDirective);
  const vietnameseOrdering = VIETNAMESE_ORDERING_CONTEXT_RE.test(text) && VIETNAMESE_ORDERING_ACTION_RE.test(text);
  const vietnameseCommitLayout = /\b(?:commit|lịch sử|nhánh)\b/iu.test(text) &&
    /(?:giữ riêng|tách riêng|gộp|squash|giữ lại|trình bày riêng)/iu.test(text) && /(?:thay vì|riêng từng|từng commit|lịch sử)/iu.test(text);
  return (reviewContext && orderingDirective) || exampleDirective || commitLayout || vietnameseOrdering || vietnameseCommitLayout;
}

const EXTERNAL_SUBJECT_EN_RE = /\b(?:cloud platform|platform|provider|vendor|runtime|browser|protocol|standard|library|dependency|api|service|system|database|framework|contract|specification|quota|rate limit)\b/iu;
const EXTERNAL_REQUIREMENT_EN_RE = /\b(?:requires|require|mandates|mandate|must|cannot|does not allow|only supports|only support)\b/iu;
const EXTERNAL_CONFIRMED_EN_RE = /\bconfirmed?\b[^.!?;]{0,80}\b(?:unavailable|unsupported|cannot|not supported|no longer supports|no longer support)\b/iu;
const EXTERNAL_SUBJECT_VI_RE = /(?:nền tảng đám mây|nền tảng|nhà cung cấp|nhà vận hành|giao thức|tiêu chuẩn|thư viện|phụ thuộc|api|dịch vụ|hệ thống|cơ sở dữ liệu|khung phần mềm|hạn mức|giới hạn tốc độ)/iu;
const EXTERNAL_REQUIREMENT_VI_RE = /(?:yêu cầu|bắt buộc|chỉ cho phép|không cho phép|không hỗ trợ|không thể|không được)/iu;
const EXTERNAL_CONFIRMED_VI_RE = /xác nhận[^.!?;]{0,100}(?:không thể|không hỗ trợ|chưa thể|không khả dụng)/iu;

export function externalConstraint(text: string): boolean {
  return text.split(/[.!?;]+/).some((clause) => {
    const enMatch = EXTERNAL_SUBJECT_EN_RE.test(clause) && (EXTERNAL_REQUIREMENT_EN_RE.test(clause) || EXTERNAL_CONFIRMED_EN_RE.test(clause));
    const viMatch = EXTERNAL_SUBJECT_VI_RE.test(clause) && (EXTERNAL_REQUIREMENT_VI_RE.test(clause) || EXTERNAL_CONFIRMED_VI_RE.test(clause));
    return enMatch || viMatch;
  });
}

const EXPLICIT_ADOPTION_PATTERNS = [
  /\b(?:we|i)\s+(?:decided|chose|choose|adopt|adopted|have adopted)\b/i,
  /\b(?:our|my) policy is\b|\bfinal decision\b|\bdecision is to\b/i,
  /(?:quyết định|đã chọn|chúng ta chọn|chốt|mình chọn|chúng tôi áp dụng|chúng ta áp dụng|chính sách của chúng tôi là)/iu,
  /(?:nhóm|đội|team)\s+(?:đã\s+)?chọn/iu,
];

export function explicitUserAdoption(text: string): boolean {
  const lower = text.toLocaleLowerCase();
  return containsAny(lower, EXPLICIT_ADOPTION_PATTERNS) || directBehaviorChoice(text);
}

const NEXT_ACTION_SKIP_RE = /^(?:the )?next(?: step| task) is\b|^(?:việc|bước) tiếp theo là\b/iu;
const NEXT_ACTION_PREFIX_EN_RE = /^(?:(?:next(?:,| step)?|please|now|first|can you|could you|let['’]s|let us)\s+)?/iu;
const NEXT_ACTION_VERB_EN_RE = /^(?:add|write|run|check|test|review|inspect|measure|verify|investigate|implement|update|change|fix|remove|confirm|compare|validate|try|rerun)\b/iu;
const NEXT_ACTION_PREFIX_VI_RE = /^(?:(?:(?:bước tiếp theo|việc tiếp theo|tiếp theo)(?: là|,| bước)?|vui lòng|bây giờ|trước tiên|hãy)\s+)?/iu;
const NEXT_ACTION_VERB_VI_RE = /^(?:thêm|bổ sung|viết|chạy|kiểm tra|xem xét|đo|xác minh|điều tra|triển khai|cập nhật|thay đổi|sửa|xóa|xác nhận|so sánh|kiểm chứng|thử|chạy lại)(?=\s|$)/iu;

export function explicitNextAction(text: string): boolean {
  const trimmed = text.trim();
  if (NEXT_ACTION_SKIP_RE.test(trimmed)) return false;
  const enVerb = NEXT_ACTION_VERB_EN_RE.test(trimmed.replace(NEXT_ACTION_PREFIX_EN_RE, ''));
  const viVerb = NEXT_ACTION_VERB_VI_RE.test(trimmed.replace(NEXT_ACTION_PREFIX_VI_RE, ''));
  return enVerb || viVerb;
}

export function explicitArchitectureChoice(text: string): boolean {
  return /\b(?:use|choose|select|build|configure|implement|keep|make)\b[^.!?]{0,120}\b(?:monolith|microservices?|architecture|single application process|request handling and scheduled jobs)\b/iu.test(text) ||
    /(?:dùng|chọn|xây dựng|triển khai|cấu hình|giữ)[^.!?]{0,120}(?:kiến trúc|đơn khối|vi dịch vụ)/iu.test(text);
}

const REPORTED_PROGRESS_ACTOR_EN_RE = /^(?:i|we|the team|our team)\s+(?:(?:have|has)\s+)?/iu;
const REPORTED_PROGRESS_VERB_EN_RE = /^(?:implemented|configured|migrated|updated|enabled|disabled|modified|refactored|rolled out|added|removed|changed|replaced|fixed|finished|completed)\b/iu;
const REPORTED_PROGRESS_ACTOR_VI_RE = /^(?:tôi|chúng tôi|nhóm)\s+(?:đã\s+)?/iu;
const REPORTED_PROGRESS_VERB_VI_RE = /^(?:triển khai|cấu hình|di chuyển|cập nhật|bật|tắt|thêm|xóa|đổi|sửa|hoàn tất|hoàn thành|đã xong)\b/iu;
const REPORTED_STATE_EN_SPLIT_RE = /\s+(?:now|currently|already)\s+(?:supports|support|accepts|accept|validates|validate|returns|return|handles|handle|routes|route|stores|store|uses|use|includes|include|allows|allow)\b/iu;
const REPORTED_STATE_VI_SPLIT_RE = /\s+(?:hiện|đã)\s+(?:hỗ trợ|chấp nhận|kiểm tra|trả về|xử lý|lưu|đọc|ghi)\b/iu;
const VALID_SUBJECT_RE = /^(?:the\s+|phần\s+)?[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+){0,9}$/iu;

function hasReportedSubjectVerbState(trimmed: string, splitRe: RegExp): boolean {
  const match = splitRe.exec(trimmed);
  if (!match || match.index <= 0) return false;
  return VALID_SUBJECT_RE.test(trimmed.slice(0, match.index));
}

export function reportedImplementationProgress(text: string): boolean {
  const trimmed = text.trim();
  const enActorProgress =
    REPORTED_PROGRESS_ACTOR_EN_RE.test(trimmed) &&
    REPORTED_PROGRESS_VERB_EN_RE.test(trimmed.replace(REPORTED_PROGRESS_ACTOR_EN_RE, ''));
  const viActorProgress =
    REPORTED_PROGRESS_ACTOR_VI_RE.test(trimmed) &&
    REPORTED_PROGRESS_VERB_VI_RE.test(trimmed.replace(REPORTED_PROGRESS_ACTOR_VI_RE, ''));
  return (
    enActorProgress ||
    viActorProgress ||
    hasReportedSubjectVerbState(trimmed, REPORTED_STATE_EN_SPLIT_RE) ||
    hasReportedSubjectVerbState(trimmed, REPORTED_STATE_VI_SPLIT_RE)
  );
}

const DIRECT_BEHAVIOR_CLAUSE_PREFIX_EN_RE = /^(?:(?:for|during|in|when|if)\s+[^,;]{1,110}[,;]\s*)?/iu;
const DIRECT_BEHAVIOR_MODAL_PREFIX_EN_RE = /^(?:(?:let['’]s|let us|we should|we will|we must|we need to)\s+)?(?:please\s+)?/iu;
const DIRECT_BEHAVIOR_VERB_EN_RE = /^(?:do not|don't|never|keep|use|choose|select|avoid|ensure|allow|configure|set|store|route|make|retry|require|only|move|leave|stop|send|retain|publish|run)\b/iu;
const DIRECT_BEHAVIOR_CLAUSE_PREFIX_VI_RE = /^(?:(?:với|trong|khi|nếu|dù)\s+[^,;]{1,110}[,;]\s*)?/iu;
const DIRECT_BEHAVIOR_MODAL_PREFIX_VI_RE = /^(?:(?:hãy|nên|cần|vẫn)\s+)?/iu;
const DIRECT_BEHAVIOR_VERB_VI_RE = /^(?:đừng|chỉ|giữ|dùng|chọn|bỏ|đổi|cứ|tránh|bật|tắt|gửi|chuyển|lưu|để|squash)(?=\s|$)/iu;

export function directBehaviorChoice(text: string): boolean {
  const trimmed = text.trim();
  const enBody = trimmed.replace(DIRECT_BEHAVIOR_CLAUSE_PREFIX_EN_RE, '').replace(DIRECT_BEHAVIOR_MODAL_PREFIX_EN_RE, '');
  const viBody = trimmed.replace(DIRECT_BEHAVIOR_CLAUSE_PREFIX_VI_RE, '').replace(DIRECT_BEHAVIOR_MODAL_PREFIX_VI_RE, '');
  return DIRECT_BEHAVIOR_VERB_EN_RE.test(enBody) || DIRECT_BEHAVIOR_VERB_VI_RE.test(viBody);
}

const HYPOTHETICAL_RETENTION_ACTION_RE = /\b(?:retain|retains|keep|keeps|purge|purges|remove|removes|expire|expires|store|stores|archive|archives)\b/iu;
const HYPOTHETICAL_RETENTION_OBJECT_RE = /\b(?:failed|errored)\s+(?:event|events|deliveries|record|records|job|jobs|request|requests)\b/iu;
const HYPOTHETICAL_MODAL_EN_RE = /\b(?:if|when|unless|may|might|could|would|should|can|cannot)\b/iu;
const HYPOTHETICAL_FAIL_WORD_EN_RE = /\b(?:fail|fails|failed|failure|error|exception|crash|wrong|broken|denied|refused)\b/iu;
const HYPOTHETICAL_NEGATED_FAIL_EN_RE = /\b(?:not|never|no)\b(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:fail|fails|failed|failure|error|exception|crash|wrong|broken|denied|refused)\b/iu;
const HYPOTHETICAL_FAILURE_CASE_EN_RE = /\b(?:failure|error|exception)\s+(?:case|condition|path|handling|message|response)\b/iu;
const HYPOTHETICAL_VI_PATTERNS = [
  /(?:nếu|trừ khi|có thể|không|chưa)[^.!?;]{0,100}(?:lỗi|thất bại|hỏng|từ chối)/iu,
  /khi[^.!?;]{0,80}(?:có thể|thường|sẽ)[^.!?;]{0,80}(?:lỗi|thất bại|hỏng|từ chối)/iu,
];

export function hypotheticalFailure(text: string): boolean {
  const lower = text.toLocaleLowerCase();
  if (HYPOTHETICAL_NEGATED_FAIL_EN_RE.test(lower) || HYPOTHETICAL_FAILURE_CASE_EN_RE.test(lower) || containsAny(lower, HYPOTHETICAL_VI_PATTERNS)) {
    return true;
  }
  return lower.split(/[.!?;]+/).some((clause) => {
    const retentionMatch = HYPOTHETICAL_RETENTION_ACTION_RE.test(clause) && HYPOTHETICAL_RETENTION_OBJECT_RE.test(clause);
    const modalMatch = HYPOTHETICAL_MODAL_EN_RE.test(clause) && HYPOTHETICAL_FAIL_WORD_EN_RE.test(clause);
    return retentionMatch || modalMatch;
  });
}

const OBSERVED_FAILURE_PATTERNS = [
  /\b(?:failure|error):\s*[^;]{0,240}\b(?:rejected|failed|crashed|denied|raised|threw|skipped|lost|duplicated)\b/iu,
  /\b(?:failed|failure occurred|error occurred|encountered an error|request error|crashed|created duplicate|produced duplicate)\b/iu,
  /\b(?:raised|threw|returned)\s+(?:an?\s+)?(?:error|exception|[A-Z][A-Z0-9_]+)\b/iu,
  /\b(?:was rejected|server rejected|request was denied|used the wrong|was wrong|was broken|was incorrect)\b/iu,
  /\bincorrectly\s+(?:copied|assigned|routed|stored)\b/iu,
  /\b(?:caused|led to|resulted in)\s+(?:the\s+)?(?:skip|loss|duplicate|failure|error|crash|rejection)\b/iu,
  /\bcaused[^.!?;]{0,100}\b(?:to be\s+)?(?:skipped|lost|duplicated|rejected)\b/iu,
  /(?:thất bại(?:\s+vì|[:;,.])|báo lỗi vì|gây ra lỗi|xảy ra lỗi|đã xảy ra lỗi|gắn nhầm|lấy nhầm|bị từ chối|từ chối đăng nhập)/iu,
  /lỗi[^.!?;]{0,50}xảy ra|tạo (?:ra )?bản ghi trùng|dừng với (?:RangeError|TypeError)/iu,
];

export function observedFailure(text: string): boolean {
  const lower = text.toLocaleLowerCase();
  if (hypotheticalFailure(lower)) return false;
  return containsAny(lower, OBSERVED_FAILURE_PATTERNS);
}

const VERIFICATION_OPEN_PATTERNS = [
  /\b(?:not yet verified|not confirmed|haven't confirmed|have not confirmed|has not confirmed|not checked yet|still need to verify)\b/iu,
  /(?:chưa xác nhận|chưa kiểm chứng|chưa kiểm tra|chưa xác minh|chưa biết)/iu,
];

const VERIFIED_OUTCOME_PATTERNS = [
  /\b(?:verified|confirmed|checked|tested|passed|pass|reran|ran again|all \d+|both|each)\b/iu,
  /\bnow\s+(?:works|returns|return|contains|contain|carry|carries|has)\b/iu,
  /(?:đối chiếu|kiểm tra|đã chạy|chạy lại|đều đúng|không còn)/iu,
];

export function explicitFixOutcome(text: string): boolean {
  if (containsAny(text, VERIFICATION_OPEN_PATTERNS)) return false;
  const directCorrection = /\b(?:fixed|corrected|repaired|normalized)\b|(?:đã sửa|khắc phục)/iu.test(text);
  const replacement = /\b(?:replaced|switched|changed)\b[^.!?]{0,120}\b(?:with|to)\b/iu.test(text) || /\b(?:đổi|chuyển|sửa|thay)\b[^.!?]{0,120}\b(?:sang|thành)\b/iu.test(text);
  const readPerRecord = /\bread\b[^.!?]{0,100}\bfrom each\b|\bđọc\b[^.!?]{0,100}\btừ từng\b/iu.test(text);
  const verified = containsAny(text, VERIFIED_OUTCOME_PATTERNS);
  return directCorrection || (replacement && verified) || (readPerRecord && verified);
}

function authorityContainsCredentials(text: string, start: number): boolean {
  let separator = -1;
  let cursor = start;
  while (cursor < text.length && text[cursor] !== '/' && text[cursor] !== '@') {
    if (text[cursor] === ':' && cursor > start && separator === -1) separator = cursor;
    cursor++;
  }
  return text[cursor] === '@' && separator !== -1 && separator < cursor - 1;
}

// Check credentials without repeatedly rescanning long malformed URL strings.
function hasCredentialUrlAfter(text: string, searchFrom: number, lineEnd: number): boolean {
  while (searchFrom < lineEnd) {
    const scheme = text.indexOf('://', searchFrom);
    if (scheme === -1 || scheme + 3 > lineEnd) return false;
    const start = scheme + 3;
    if (authorityContainsCredentials(text, start)) return true;
    searchFrom = start;
  }
  return false;
}

function hasCredentialConnectionString(text: string): boolean {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const marker = /\bconnection string\b/iu.exec(text.slice(lineStart, lineEnd));
    if (marker && hasCredentialUrlAfter(text, lineStart + marker.index + marker[0].length, lineEnd)) return true;
    if (newline === -1) return false;
    lineStart = newline + 1;
  }
  return false;
}

const ASSISTANT_HYPOTHESIS_PATTERNS = [
  /\b(?:might|may|could)\s+(?:be|come|result|stem|arise|indicate|cause)\b/iu,
  /\bpossibly caused by\b/iu,
  /có thể[^.!?;]{0,100}bị/iu,
];

const ASSISTANT_CAVEAT_PATTERNS = [
  /\b(?:no trace|no evidence|no data|cannot confirm|can't confirm|unknown whether|unclear whether|not enough evidence)\b/iu,
  /(?:chưa có trace|chưa trace|chưa có bằng chứng|chưa bằng chứng|chưa có dữ liệu|chưa dữ liệu|chưa rõ|không rõ|chưa xác định)/iu,
];

export function classifyAssistant(lower: string): Classification {
  // Assistant text cannot establish decisions, changes, errors, or outcomes.
  // Keep only a causally framed hypothesis with an explicit evidence caveat.
  const hypothesis = containsAny(lower, ASSISTANT_HYPOTHESIS_PATTERNS);
  const caveat = containsAny(lower, ASSISTANT_CAVEAT_PATTERNS);
  const assurance = /\b(?:successfully|passed|completed|deployed|healthy)\b|(?:thành công|đã chạy thành công)/iu.test(lower);
  const uncertain = hypothesis && caveat && !assurance;
  return uncertain ? { kind: 'OPEN_QUESTION', certainty: 'uncertain', confidence: 0.65 } : null;
}

const TOOL_FIXED_PATTERNS = [
  /\b(?:fixed|resolved|corrected|repaired|eliminated)\b/iu,
  /\b(?:removed the error|removed the bug|removed the duplicate|prevented the error|prevented the bug|prevented the duplicate)\b/iu,
  /\bafter\b.{0,160}\b(?:added|changed|removed|cleared|patched|fixed|normalized)\b/iu,
  /(?:đã sửa lỗi|khắc phục được lỗi|khắc phục lỗi|đã khắc phục|sửa được lỗi)/iu,
  /sau khi[^.!?;]{0,160}(?:bỏ|thêm|đổi|chuẩn hóa)/iu,
];

const TOOL_CONDITIONAL_FAIL_PATTERNS = [
  /\b(?:when|if|unless)\b[^.!?;]{0,140}\b(?:fail|fails|return non-zero|returns non-zero|return nonzero|returns nonzero|return non zero|returns non zero|exit non-zero|exits non-zero|exit nonzero|exits nonzero|exit non zero|exits non zero|is unavailable)\b/iu,
  /\b(?:return|returns) non[- ]?zero\b[^.!?;]{0,80}\bif\b/iu,
  /(?:nếu|khi)[^.!?;]{0,140}(?:trả về mã khác không|không khả dụng)/iu,
];

const TOOL_SUCCESS_PATTERNS = [
  /\b(?:exit_code\s*=\s*0|completed successfully|saved successfully)\b/iu,
  /\b(?:\d+\s+tests?\s+passed|passed all \d+ tests?)\b/iu,
  /(?:chạy qua đủ \d+ bài|đạt đủ \d+ bài kiểm thử|kiểm thử thành công)/iu,
];

const TOOL_OBSERVATION_PATTERNS = [
  /\b(?:log|trace|response|output|manifest|documentation|report)\b[^.!?;]{0,120}\b(?:show|shows|list|lists|contain|contains|record|records|report|reports|state|states)\b/iu,
  /(?:log|dấu vết|phản hồi|tài liệu|báo cáo)[^.!?;]{0,120}(?:cho thấy|ghi nhận|liệt kê|nêu rõ)/iu,
];

export function classifyTool(normalized: string, lower: string): Classification {
  if (hasCredentialConnectionString(normalized)) return null;
  const explicitFailure = /\boutcome\s*:\s*failed\b|\bexit_code\s*=\s*[1-9]\d*\b/i.test(lower);
  if (explicitFailure) return { kind: 'MISTAKE', certainty: 'reported', confidence: 0.84 };
  const explicitSuccess = /\bexit_code\s*=\s*0\b/i.test(lower);
  if (explicitSuccess) return { kind: 'TASK_STATUS', certainty: 'reported', confidence: 0.8 };
  if (containsAny(lower, TOOL_FIXED_PATTERNS)) return { kind: 'FIX', certainty: 'reported', confidence: 0.82 };
  const failed = observedFailure(normalized) && /\b(?:failed|failure|fail|error|exception|crash|RangeError|SQLITE_CONSTRAINT|thất bại|lỗi)\b/iu.test(lower);
  if (failed) return { kind: 'MISTAKE', certainty: 'reported', confidence: 0.82 };
  if (hypotheticalFailure(normalized) || containsAny(normalized, TOOL_CONDITIONAL_FAIL_PATTERNS)) {
    return { kind: 'FACT', certainty: 'reported', confidence: 0.74 };
  }
  if (containsAny(lower, TOOL_SUCCESS_PATTERNS)) return { kind: 'TASK_STATUS', certainty: 'reported', confidence: 0.8 };
  const structuredEvidence = /(?:^|\s)(?:[\w@.-]+\/)+[\w@./-]+|\b[A-Za-z_$][\w$]*(?:<[^>]+>)?\s*\(|\b[A-Z][A-Z\d_]{1,}\b|\b(?:\d{1,3}\.){3}\d{1,3}:?\d*\b|\b(?:HTTP|SQLITE|ECONN|RangeError|TypeError)[-_ ]?\d*\b/u.test(normalized); // NOSONAR
  const observation = containsAny(normalized, TOOL_OBSERVATION_PATTERNS);
  return structuredEvidence || observation ? { kind: 'FACT', certainty: 'reported', confidence: 0.76 } : null;
}

const REPORTED_TASK_STATUS_PATTERNS = [
  /\b(?:completed|are complete|is complete|finished|unfinished|remaining work|next step|blocked|still need|not been run|have not run)\b/i,
  /\bnext,|\btests? passed\b|\bpassed all \d+ tests?\b/i,
  /(?:đã hoàn thành|việc tiếp theo|còn lại|bị chặn|chưa chạy|đã xong|chưa được viết|chưa làm|tiếp theo|chạy qua đủ)/iu,
  /^next[, :]/i,
];

const REPORTED_FIX_PATTERNS = [
  /\b(?:fix|fixed|resolve|resolved|repair|repaired|replace|replaced|refactor|refactored)\b/i,
  /\b(?:preserve|preserved|preserving|correct|corrected|client now sends)\b/i,
  /(?:đã sửa lỗi|khắc phục|giữ nguyên|đã lưu)/iu,
];

const REPORTED_MEASURED_PATTERNS = [
  /\b\d+(?:\.\d+)?\s*(?:ms|mb|gb|kb|file|files|row|rows|item|items|test|tests|request|requests|percent|%)/iu,
  /\b(?:UTC|HTTP\s*\d{3}|port\s+\d+)\b/iu,
];

const REPORTED_IMPERATIVE_PREFIX_EN_RE = /(?:^|[.;:]\s*)(?:please\s+)?/iu;
const REPORTED_IMPERATIVE_VERB_EN_RE = /^(?:do not|don't|never|keep|use|choose|select|avoid|ensure|allow|configure|set|store|route|make|retry|require|only|cancel|move|put|leave)\b/iu;
const REPORTED_IMPERATIVE_VI_RE = /(?:^|[.;,:]\s*)(?:đừng|chỉ|giữ|dùng|chọn|bỏ|đổi|cứ|hãy|tránh|bật|tắt)\b/iu;

function hasReportedImperative(normalized: string): boolean {
  if (REPORTED_IMPERATIVE_VI_RE.test(normalized)) return true;
  return normalized
    .split(/[.;:]\s*/)
    .some((clause) => REPORTED_IMPERATIVE_VERB_EN_RE.test(clause.replace(REPORTED_IMPERATIVE_PREFIX_EN_RE, '')));
}

const TECHNICAL_CONTEXT_PATTERNS = [
  /\b(?:api|endpoint|route|project|tenant|schema|migration|database|sqlite|postgres|postgresql|query|memory|vector|token|cursor)\b/i,
  /\b(?:test|tests|hook|hooks|persist|persisted|return|returns|support|supports|store|stores|use|uses|require|requires)\b/i,
  /\b(?:worker|server|client|request|response|queue|transaction|gateway|handler|profile|chart|load|scheduler|variable|configuration)\b/i,
  /\b(?:manifest|checksum|file|socket|connection|table|column|webhook|invoice|upload|archive|release|branch|proxy|header|health|integration|credential|environment|smoke|assistant)\b/i,
  /\b(?:project_id|tenant_id|exit_code|test-concurrency|api_key|global top-k|mcp|tag\s*:|finished_at)\b/i,
];

export function classifyReported(normalized: string, lower: string): Classification {
  if (explicitFixOutcome(normalized)) return { kind: 'FIX', certainty: 'reported', confidence: 0.82 };
  if (reportedImplementationProgress(normalized)) return { kind: 'TASK_STATUS', certainty: 'reported', confidence: 0.82 };

  if (containsAny(lower, REPORTED_TASK_STATUS_PATTERNS)) {
    return { kind: 'TASK_STATUS', certainty: /^(?:next[, :]|next step)/i.test(normalized) ? 'explicit' : 'reported', confidence: 0.82 };
  }
  if (containsAny(lower, REPORTED_FIX_PATTERNS)) {
    return { kind: 'FIX', certainty: 'reported', confidence: 0.78 };
  }
  if (observedFailure(normalized)) {
    return { kind: 'MISTAKE', certainty: 'reported', confidence: 0.82 };
  }
  if (containsAny(normalized, REPORTED_MEASURED_PATTERNS)) return { kind: 'FACT', certainty: 'reported', confidence: 0.76 };
  if (hasReportedImperative(normalized)) {
    return { kind: 'DECISION', certainty: 'explicit', confidence: 0.88 };
  }
  const codeOrPath = /(?:^|\s)(?:[\w@.-]+\/)+[\w@./-]+|\b[A-Za-z_$][\w$]*(?:<[^>]+>)?\s*\(|\b[A-Z][A-Z\d_]{1,}\b|\b(?:\d{1,3}\.){3}\d{1,3}:?\d*\b|\b(?:HTTP|SQLITE|ECONN|RangeError|TypeError)[-_ ]?\d*\b/u.test(normalized); // NOSONAR
  const technicalContext = containsAny(lower, TECHNICAL_CONTEXT_PATTERNS);
  return (codeOrPath || technicalContext) && normalized.length >= 20
    ? { kind: 'FACT', certainty: 'reported', confidence: 0.76 } : null;
}

const USER_OPEN_QUESTION_PATTERNS = [
  /\b(?:should we|what should|how should|open question|unresolved question|remaining question)\b/i,
  /\b(?:need to decide|yet to decide|still need to determine|need to find out whether|unclear whether|unknown whether|have not decided whether|haven't decided whether)\b/i,
  /(?:có nên|làm thế nào|câu hỏi còn mở|câu hỏi mở|chưa rõ|chưa xác định|chưa biết|hay không)/iu,
];

const USER_DECISION_PATTERNS = [
  /\b(?:we decided|we chose|we choose|we selected|i decided|i chose|our policy is|the policy is|we adopted|we adopt|final decision|decision is to)\b/i,
  /\b(?:the|our) (?:api|service|system) will use\b/i,
  /(?:quyết định|đã chọn|chúng ta chọn|chốt|mình chọn)/iu,
  /(?:nhóm|đội|team)\s+(?:đã\s+)?chọn/iu,
  /^decision\s*:/i,
];

const USER_PREFERENCE_PATTERNS = [
  /\b(?:i|we)\s+(?:prefer|like|want|would rather)\b/i,
  /\b(?:i|we)\s+(?:now|usually|generally|always|typically)\s+(?:prefer|like|want|would rather)\b/i,
  /\b(?:preference|earlier i asked for|previously i asked for|from now on)\b/i,
  /(?:thích|muốn|ưu tiên|từ nay|từ các lần|đổi thứ tự)/iu,
];

const USER_WHATEVER_PREFIX_RE = /^(?:whatever the answer|regardless of the answer|either way|dù câu trả lời là gì|dù kết quả thế nào)[,;:]?\s+/iu;

const USER_MUST_BE_PATTERNS = [
  /\b(?:must be blank|must be empty|must be preserved|must be unchanged|must remain|should be blank|should be empty)\b/iu,
  /(?:phải để ô trống|phải để trống|phải giữ nguyên|phải được giữ)/iu,
];

export function classifyUser(normalized: string, lower: string): Classification {
  if (unresolvedQuestionWithContext(normalized) || containsAny(lower, USER_OPEN_QUESTION_PATTERNS)) {
    return { kind: 'OPEN_QUESTION', certainty: 'uncertain', confidence: 0.72 };
  }
  if (normalized.endsWith('?')) return null;
  if (/^the (?:test|build|smoke) report confirms\b/iu.test(lower)) return null;

  if (/\b(?:cancel that queue|cancel that choice|cancel that decision|we superseded it)\b/iu.test(lower)) {
    return { kind: 'DECISION', certainty: 'explicit', confidence: 0.88 };
  }
  if (containsAny(lower, USER_DECISION_PATTERNS)) {
    return { kind: 'DECISION', certainty: 'explicit', confidence: 0.92 };
  }
  if (workflowPreference(normalized) || presentationPreference(normalized) || containsAny(lower, USER_PREFERENCE_PATTERNS)) {
    return { kind: 'PREFERENCE', certainty: 'explicit', confidence: 0.9 };
  }
  if (explicitNextAction(normalized)) return { kind: 'TASK_STATUS', certainty: 'explicit', confidence: 0.86 };
  if (USER_WHATEVER_PREFIX_RE.test(normalized) && directBehaviorChoice(normalized.replace(USER_WHATEVER_PREFIX_RE, ''))) {
    return { kind: 'DECISION', certainty: 'explicit', confidence: 0.88 };
  }
  if (directBehaviorChoice(normalized)) return { kind: 'DECISION', certainty: 'explicit', confidence: 0.88 };

  // State external requirements as reported facts unless the USER explicitly
  // adopts them as policy in the choice rules above.
  if (externalConstraint(normalized)) return { kind: 'FACT', certainty: 'reported', confidence: 0.78 };
  if (containsAny(normalized, USER_MUST_BE_PATTERNS)) {
    return { kind: 'DECISION', certainty: 'explicit', confidence: 0.86 };
  }

  return classifyReported(normalized, lower);
}

export function classify(text: string, role: SourceRole): Classification {
  const normalized = text.trim();
  const lower = normalized.toLocaleLowerCase();
  if (nonMemoryText(normalized)) return null;

  if (role === 'ASSISTANT') return classifyAssistant(lower);
  if (role === 'USER' && explicitFixOutcome(normalized)) return { kind: 'FIX', certainty: 'reported', confidence: 0.82 };
  if (role === 'USER' && reportedImplementationProgress(normalized)) return { kind: 'TASK_STATUS', certainty: 'reported', confidence: 0.82 };
  if (role === 'TOOL') return classifyTool(normalized, lower);
  return classifyUser(normalized, lower);
}

const EXPLICIT_CHOICE_CHANGE_PATTERNS = [
  /\b(?:preference changed|decision changed|updated decision|new decision replaces|new decision supersedes|from now on|final decision|that preference changed|we superseded it)\b/iu,
  /\b(?:changed my preference|changed my decision|changed our preference|changed our decision|cancel that queue|cancel that choice|cancel that decision)\b/iu,
  /(?:quyết định mới thay thế|sở thích đã thay đổi|sở thích thay đổi|thay đổi quyết định|từ nay|từ các lần|đổi thứ tự|bỏ phương án|quyết định cuối cùng)/iu,
];

export function hasExplicitChoiceChange(text: string): boolean {
  return containsAny(text, EXPLICIT_CHOICE_CHANGE_PATTERNS);
}

export const HISTORICAL_CHOICE = /^(?:earlier|previously|previous preference|previous decision|old decision)\b|^(?:quyết định cũ|trước đây|trước đó)/iu;

const DIRECT_REPLACEMENT_PATTERNS = [
  /\b(?:new decision replaces|new decision supersedes|that preference changed)\b/iu,
  /\b(?:changed my preference|changed my decision|changed our preference|changed our decision)\b/iu,
  /(?:quyết định mới thay thế|sở thích đã thay đổi|sở thích thay đổi|thay đổi quyết định)/iu,
];

export function explicitSameEventReplacement(current: StructuredMemory, previous: StructuredMemory): boolean {
  return containsAny(current.content, DIRECT_REPLACEMENT_PATTERNS) && HISTORICAL_CHOICE.test(previous.content);
}
