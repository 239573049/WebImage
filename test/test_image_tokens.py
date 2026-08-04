from __future__ import annotations

import unittest

from utils.image_tokens import (
    compensate_image_generation_output_tokens,
    count_image_input_tokens,
    count_image_output_tokens,
)


class ImageTokenTests(unittest.TestCase):
    def test_patch_token_examples_match_openai_docs(self):
        self.assertEqual(count_image_input_tokens(1024, 1024, "gpt-4.1-mini", "high"), 1659)
        self.assertEqual(count_image_input_tokens(1800, 2400, "gpt-4.1-mini", "high"), 2353)

    def test_image_input_tokens_force_gpt_54_mini(self):
        expected = count_image_input_tokens(1024, 1024, "gpt-5.4-mini", "low")
        self.assertEqual(expected, 415)
        self.assertEqual(count_image_input_tokens(1024, 1024, "gpt-4o", "low"), expected)
        self.assertEqual(count_image_input_tokens(1024, 1024, "gpt-image-2", "low"), expected)

    def test_image_output_tokens_scale_by_count_and_size(self):
        single = count_image_output_tokens("1024x1024", "auto", 1)
        self.assertGreater(single, 0)
        self.assertEqual(count_image_output_tokens("1024x1024", "auto", 2), single * 2)

    def test_compensates_image_generation_tokens_below_900(self):
        self.assertEqual(compensate_image_generation_output_tokens(899), 1249)
        self.assertEqual(compensate_image_generation_output_tokens(900), 900)


if __name__ == "__main__":
    unittest.main()
