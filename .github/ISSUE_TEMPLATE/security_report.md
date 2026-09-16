---
name: Security Report
about: Report a security vulnerability — please read before filing
title: "[SECURITY] "
labels: security
assignees: ''

---

<!--
  ⚠️  STOP — DO NOT FILE A PUBLIC ISSUE FOR SECURITY VULNERABILITIES  ⚠️

  If you have discovered a vulnerability in Ledgera, please report it
  privately so that it can be triaged and patched before public disclosure.

  Public issues expose all users to risk before a fix is available.
-->

## Please use GitHub Security Advisories

Report vulnerabilities confidentially via:

**[🔒 Open a private Security Advisory](https://github.com/MiLedgera/Ledgera/security/advisories/new)**

This ensures:
- The report is visible only to maintainers
- We can coordinate a fix before disclosure
- You receive credit in the release notes

---

## Full Responsible Disclosure Policy

See [SECURITY.md](../../SECURITY.md) for:

- Scope and severity definitions
- Response SLAs (acknowledgement within 48 h, patch timeline by severity)
- Core security invariants (spending limits, secret externalization, simulation-before-broadcast)
- Secret management guidelines
- What to include in your report for fastest triage

---

## Not a Vulnerability?

If your report is not a security issue but rather a general bug or a question about security best practices:

- **Bug report**: Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) template
- **Question**: Open an issue with the `question` label

---

> This template intentionally does not collect vulnerability details.
> All sensitive information must be submitted through the private advisory link above.
