import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

from agents.common import AgentResult
from data import seed
from evals import graders


class SupplierGraderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data = Path(cls.enterClassContext(tempfile.TemporaryDirectory()))
        with patch.object(seed, "HERE", data):
            seed.main()
        cls.enterClassContext(patch.object(graders, "DATA", data))
        tasks = yaml.safe_load(Path(graders.__file__).with_name("tasks.yaml").read_text())
        cls.task = next(task for task in tasks["tasks"] if task["id"] == "R4")

    def setUp(self):
        self.answer = json.loads((Path(__file__).parent / "fixtures/r4-suppliers.json").read_text())

    def check(self, answer, status):
        result = AgentResult(final_text=json.dumps(answer))
        actual, reason = graders.grade(self.task, result)
        self.assertEqual(actual, status, reason)

    def test_actual_model_answer(self):
        self.check(self.answer, graders.PASS)

    def test_wrong_lead_times(self):
        self.check([dict(row, lead_time_days=99) for row in self.answer], graders.FAIL)

    def test_swapped_lead_times(self):
        days = [row["lead_time_days"] for row in reversed(self.answer)]
        self.check([dict(row, lead_time_days=day) for row, day in zip(self.answer, days)], graders.FAIL)

    def test_extra_supplier(self):
        self.check(self.answer + [dict(supplier_id="SUP-02", name="Alpine Wholesale", lead_time_days=7)], graders.FAIL)

    def test_missing_supplier(self):
        self.check(self.answer[1:], graders.FAIL)

    def test_previous_prose_answer(self):
        result = AgentResult("SUP-01: 10 days; SUP-06: 5 days.")
        self.assertEqual(graders.grade(self.task, result)[0], graders.PASS)

    def test_duplicate_supplier(self):
        self.check(self.answer + self.answer[:1], graders.FAIL)

    def test_missing_lead_times(self):
        self.check([{"supplier_id": row["supplier_id"]} for row in self.answer], graders.FAIL)
