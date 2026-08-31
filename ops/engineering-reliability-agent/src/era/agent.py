from __future__ import annotations

from importlib.resources import files

from .models import IncidentAssessment


def load_instructions() -> str:
    return files("era").joinpath("prompt.md").read_text(encoding="utf-8")


def build_agent(*, model: str | None = None):  # noqa: ANN201
    from agents import Agent

    options = {
        "name": "BaristaMatch Engineering & Reliability Agent",
        "instructions": load_instructions(),
        "output_type": IncidentAssessment,
    }
    if model:
        options["model"] = model
    return Agent(**options)


async def run_agent_analysis(
    prompt: str, *, model: str | None = None
) -> IncidentAssessment:
    from agents import Runner

    result = await Runner.run(build_agent(model=model), prompt)
    output = result.final_output
    if not isinstance(output, IncidentAssessment):
        raise RuntimeError("Agent returned an unexpected output type")
    return output
