"""Agent dependency install — RCE guard (BO-7 fast pass).

`_install_agent_deps` runs pip/uv install straight into the SHARED gateway
venv from an agent repo's requirements.txt, ahead of any tool-call permission
gate. An sdist's setup.py / PEP 517 build backend can execute arbitrary code
during that install. These lock that installs default to wheels-only
(--only-binary=:all:) and that the explicit settings opt-out still works.
"""
from __future__ import annotations

import subprocess
import types

import pytest

from acb_skills.loader import _install_agent_deps


class _FakeCompleted:
    returncode = 0
    stdout = ""
    stderr = ""


def _settings(*, allow_source_builds: bool = False) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        agent_deps_allow_source_builds=allow_source_builds,
    )


def test_default_install_is_wheels_only(tmp_path, monkeypatch):
    (tmp_path / "requirements.txt").write_text("requests==2.31.0\n", encoding="utf-8")

    captured: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        captured.append(list(cmd))
        return _FakeCompleted()

    monkeypatch.setattr(subprocess, "run", _fake_run)

    _install_agent_deps(tmp_path, _settings())

    assert captured, "pip/uv install was never invoked"
    cmd = captured[0]
    assert "--only-binary" in cmd
    assert cmd[cmd.index("--only-binary") + 1] == ":all:"


def test_source_builds_opt_out_omits_the_flag(tmp_path, monkeypatch):
    (tmp_path / "requirements.txt").write_text("requests==2.31.0\n", encoding="utf-8")

    captured: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        captured.append(list(cmd))
        return _FakeCompleted()

    monkeypatch.setattr(subprocess, "run", _fake_run)

    _install_agent_deps(tmp_path, _settings(allow_source_builds=True))

    assert captured, "pip/uv install was never invoked"
    assert "--only-binary" not in captured[0]


def test_no_declared_deps_never_invokes_install(tmp_path, monkeypatch):
    captured: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        captured.append(list(cmd))
        return _FakeCompleted()

    monkeypatch.setattr(subprocess, "run", _fake_run)

    _install_agent_deps(tmp_path, _settings())

    assert captured == []
