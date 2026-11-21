"""Import and review Arena question classifications in the configured local database."""

import argparse
from functools import partial
import json
from pathlib import Path
import sys


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def make_intake(runtime):
    from backend.learning.question_intake import QuestionIntake

    settings = runtime.practice_model_config()
    router = runtime.PRACTICE_ROUTER if settings["AI_BASE_URL"] and settings["AI_API_KEY"] else runtime.ROUTER
    return QuestionIntake(runtime.ARENA_BANK, partial(runtime.routed_reply, router=router))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    classify = actions.add_parser("classify")
    classify.add_argument("scope", type=Path)
    classify.add_argument("--limit", type=int)
    classify.add_argument("--retry-pending", action="store_true")
    listing = actions.add_parser("list")
    listing.add_argument("--status", choices=("pending", "published", "withdrawn"))
    actions.add_parser("publish").add_argument("decisions", type=Path)
    withdraw = actions.add_parser("withdraw")
    withdraw.add_argument("id")
    withdraw.add_argument("revision")
    args = parser.parse_args(argv)
    if args.action == "classify" and args.limit is not None and args.limit < 1:
        parser.error("--limit 必须大于 0")

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import server

    catalog = server.ARENA_BANK.catalog
    intake = make_intake(server)
    try:
        if args.action == "classify":
            chapters = intake.register(read_json(args.scope))
            result = intake.classify(chapters, limit=args.limit, retry_pending=args.retry_pending)
        elif args.action == "list":
            result = [
                {"id": row["id"], "pointId": row["point_id"], "kind": row["kind"],
                 "revision": row["revision_hash"], "status": row["status"], **row["assessment"]}
                for row in catalog.assignments(args.status).values()
            ]
        elif args.action == "publish":
            result = {"published": intake.publish(read_json(args.decisions))}
        else:
            catalog.withdraw(args.id, args.revision)
            result = {"withdrawn": 1}
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if args.action == "classify" and result["unavailable"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
