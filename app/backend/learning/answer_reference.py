"""Runtime validation shared by parent references and offline release checks."""

from backend.learning.generated_practice import validate_answer_evidence
import hashlib, json


def reference_hash(question):
    value = {
        k: question.get(k)
        for k in (
            "id",
            "stem",
            "options",
            "answer",
            "solution",
            "explanation",
            "diagramImageHash",
            "curriculumContextHash",
            "qualityAuditVersion",
            "answerEvidence",
            "qualityAudit",
        )
    }
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()


def check_reference(question):
    answer = question.get("answer")
    steps = question.get("solution")
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError("reference_answer_missing")
    if (
        not isinstance(steps, list)
        or len(steps) < 2
        or any(not isinstance(s, str) or not s.strip() for s in steps)
    ):
        raise ValueError("reference_solution_incomplete")
    if question.get("type") == "choice":
        options = question.get("options", [])
        if not options or sum(o.get("id") == answer for o in options) != 1:
            raise ValueError("reference_choice_does_not_match_option")
    audits = question.get("qualityAudit", [])
    if [a.get("role") for a in audits] != [
        "teacher",
        "student",
        "lead",
        "expert",
    ] or any(
        a.get("passed") is not True or a.get("simulated") is not True for a in audits
    ):
        raise ValueError("reference_four_role_review_incomplete")
    validate_answer_evidence(question)
