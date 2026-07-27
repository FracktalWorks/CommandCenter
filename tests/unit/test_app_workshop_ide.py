"""App Workshop Advanced/IDE view — backend build-trigger helpers.

`gateway.routes.apps.files` gained a T2 rebuild-on-save endpoint
(`POST /{slug}/build`) alongside the existing read/write file endpoints, for
the Advanced view's real Monaco editor. These lock the pure decision
(`_is_buildable_manifest`, resolved from `entry` — never the `tier` display
field, matching every other backend read path) and the subprocess wrapper
(`_run_build_t2`, faked so no real Docker/node is needed).
"""
from __future__ import annotations

import asyncio

import pytest
from gateway.routes.apps.files import _is_buildable_manifest, _run_build_t2


def test_t1_manifest_is_not_buildable():
    assert _is_buildable_manifest({"entry": "index.html"}) is False


def test_default_manifest_with_no_entry_is_not_buildable():
    assert _is_buildable_manifest({}) is False
    assert _is_buildable_manifest(None) is False


def test_t2_manifest_is_buildable():
    assert _is_buildable_manifest({"entry": "dist/bundle.html"}) is True


class _FakeProc:
    def __init__(self, returncode: int, stdout: bytes, stderr: bytes):
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self):
        return self._stdout, self._stderr


@pytest.mark.asyncio
async def test_run_build_t2_success_returns_stdout(monkeypatch, tmp_path):
    captured = {}

    async def _fake_exec(*args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        captured["cwd"] = kwargs.get("cwd")
        return _FakeProc(0, b"build_t2: ok, dist/bundle.html (123 bytes)\n", b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(
        "gateway.routes.apps.files.t2_vendor_dir", lambda: tmp_path / "vendor",
    )

    ok, output = await _run_build_t2(tmp_path, tmp_path / "build_t2.mjs")

    assert ok is True
    assert "dist/bundle.html" in output
    assert captured["args"] == ("node", str(tmp_path / "build_t2.mjs"))
    assert captured["cwd"] == str(tmp_path)
    assert captured["env"]["CUSTOM_APPS_T2_VENDOR_DIR"] == str(tmp_path / "vendor")


@pytest.mark.asyncio
async def test_run_build_t2_failure_returns_stderr(monkeypatch, tmp_path):
    async def _fake_exec(*args, **kwargs):
        return _FakeProc(1, b"", b"build_t2: esbuild threw: unexpected token\n")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(
        "gateway.routes.apps.files.t2_vendor_dir", lambda: tmp_path / "vendor",
    )

    ok, output = await _run_build_t2(tmp_path, tmp_path / "build_t2.mjs")

    assert ok is False
    assert "unexpected token" in output


@pytest.mark.asyncio
async def test_run_build_t2_never_raises_when_node_missing(monkeypatch, tmp_path):
    async def _raise_exec(*args, **kwargs):
        raise FileNotFoundError("node: command not found")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _raise_exec)
    monkeypatch.setattr(
        "gateway.routes.apps.files.t2_vendor_dir", lambda: tmp_path / "vendor",
    )

    ok, output = await _run_build_t2(tmp_path, tmp_path / "build_t2.mjs")

    assert ok is False
    assert "node" in output.lower()


@pytest.mark.asyncio
async def test_run_build_t2_times_out_cleanly(monkeypatch, tmp_path):
    async def _fake_exec(*args, **kwargs):
        class _HangingProc:
            returncode = None

            async def communicate(self):
                await asyncio.sleep(10)
                return b"", b""

        return _HangingProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(
        "gateway.routes.apps.files.t2_vendor_dir", lambda: tmp_path / "vendor",
    )
    monkeypatch.setattr("gateway.routes.apps.files.BUILD_TIMEOUT_SECONDS", 0.05)

    ok, output = await _run_build_t2(tmp_path, tmp_path / "build_t2.mjs")

    assert ok is False
