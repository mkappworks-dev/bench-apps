#!/usr/bin/env python3
"""Send sample mail to DevBench's SMTP catcher so the Email tab has something
to show. The catcher must be running — start the app first.

    python3 scripts/seed-mail.py                 # all samples, localhost:1025
    python3 scripts/seed-mail.py --port 2025
    python3 scripts/seed-mail.py --count 1
"""

import argparse
import smtplib
import sys
from email.message import EmailMessage

DEFAULT_PORT = 1025

# Deliberately varied: the viewer has HTML / Plain / Raw / Headers modes and a
# subject-or-address filter, and each only shows its worth against a message
# that exercises it.
SAMPLES = [
    {
        "subject": "Order confirmation #8841",
        "to": ["customer@example.com"],
        "text": "Thanks for your order, Jamie. It ships tomorrow.",
        "html": "<h1>Order confirmed</h1><p>Thanks for your order, <b>Jamie</b>. It ships tomorrow.</p>",
    },
    {
        "subject": "Password reset requested",
        "to": ["jamie@example.com"],
        "text": "Use the link below within 30 minutes.\n\nhttps://shop.test/reset?token=abc123",
        "html": None,
    },
    {
        "subject": "Your receipt from Acme",
        "to": ["billing@example.com", "accounts@example.com"],
        "text": None,
        "html": (
            "<table style='border-collapse:collapse'>"
            "<tr><th style='text-align:left;padding:4px 12px'>Item</th>"
            "<th style='text-align:left;padding:4px 12px'>Total</th></tr>"
            "<tr><td style='padding:4px 12px'>Widget</td><td style='padding:4px 12px'>£24.00</td></tr>"
            "</table>"
        ),
    },
    {
        # No Subject header at all — the capture path labels this "(no subject)"
        # rather than dropping the message.
        "subject": None,
        "to": ["audit@shop.test"],
        "text": "A message with no subject header.",
        "html": None,
    },
]


def build(sample: dict, sender: str) -> EmailMessage:
    message = EmailMessage()
    if sample["subject"] is not None:
        message["Subject"] = sample["subject"]
    message["From"] = sender
    message["To"] = ", ".join(sample["to"])
    # An html-only sample must not gain an empty text part, or the viewer's
    # "no plain-text part" state never gets exercised.
    if sample["text"] and sample["html"]:
        message.set_content(sample["text"])
        message.add_alternative(sample["html"], subtype="html")
    elif sample["html"]:
        message.set_content(sample["html"], subtype="html")
    else:
        message.set_content(sample["text"] or "")
    return message


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed DevBench's inbox with sample mail.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--from", dest="sender", default="orders@shop.test")
    parser.add_argument("--count", type=int, help="send only the first N samples")
    args = parser.parse_args()

    samples = SAMPLES[: args.count] if args.count else SAMPLES

    try:
        server = smtplib.SMTP(args.host, args.port, timeout=5)
    except OSError as error:
        print(
            f"Could not reach a catcher on {args.host}:{args.port} ({error}).\n"
            "Start DevBench first, and check Settings > General if you changed the SMTP port.",
            file=sys.stderr,
        )
        return 1

    with server:
        for sample in samples:
            server.send_message(build(sample, args.sender))
            print(f"sent: {sample['subject'] or '(no subject)'} -> {', '.join(sample['to'])}")

    print(f"\n{len(samples)} message(s) sent to {args.host}:{args.port}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
