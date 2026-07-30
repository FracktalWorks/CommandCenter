"""Workflow engine — transport-free core (spec: workflows_app.md §3.1).

Pure modules with no FastAPI/DB imports so the engine can be unit-tested in
isolation and moved into the orchestrator process unchanged if run isolation
later demands it (spec Q2):

- ``templating``  — the ``{{…}}`` state bus: resolve refs against run state
- ``graph``       — edit-model validation + compile to the flat run-model DAG
- ``modules``     — Module Studio code validation + subprocess execution
- ``handlers``    — one handler per node *type*, over injected NodeServices
- ``runner``      — compile the run-model to a MAF WorkflowBuilder and execute
"""
