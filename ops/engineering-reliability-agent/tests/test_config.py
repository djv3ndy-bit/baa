import os
import unittest
from unittest.mock import patch

from era.config import DEFAULT_MODEL, AgentConfig


class AgentConfigTests(unittest.TestCase):
    def test_defaults_to_cost_controlled_model(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = AgentConfig.from_environment()

        self.assertEqual(config.model, DEFAULT_MODEL)
        self.assertEqual(config.model, "gpt-5.4-mini")

    def test_owner_can_override_model_through_environment(self) -> None:
        with patch.dict(os.environ, {"ERA_MODEL": "approved-model"}, clear=True):
            config = AgentConfig.from_environment()

        self.assertEqual(config.model, "approved-model")


if __name__ == "__main__":
    unittest.main()
