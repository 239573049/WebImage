from __future__ import annotations

import base64
import unittest
from unittest import mock

from services.protocol.conversation import ImageGenerationError, format_image_result


class ImageResponseFormatTests(unittest.TestCase):
    def setUp(self) -> None:
        self.encoded = base64.b64encode(b"image-bytes").decode("ascii")

    def test_b64_json_only_returns_base64(self) -> None:
        with mock.patch("services.protocol.conversation.save_image_bytes") as save:
            result = format_image_result([{"b64_json": self.encoded}], "cat", "b64_json")

        self.assertEqual(result["data"], [{"b64_json": self.encoded, "revised_prompt": "cat"}])
        save.assert_not_called()

    def test_url_uploads_and_only_returns_url(self) -> None:
        with mock.patch(
            "services.protocol.conversation.save_image_bytes",
            return_value="https://means.test/bucket/image.png",
        ) as save:
            result = format_image_result([{"b64_json": self.encoded}], "cat", "url")

        self.assertEqual(
            result["data"],
            [{"url": "https://means.test/bucket/image.png", "revised_prompt": "cat"}],
        )
        save.assert_called_once_with(b"image-bytes", None)

    def test_invalid_response_format_fails_before_formatting(self) -> None:
        with self.assertRaises(ImageGenerationError) as raised:
            format_image_result([{"b64_json": self.encoded}], "cat", "invalid")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.param, "response_format")


if __name__ == "__main__":
    unittest.main()
