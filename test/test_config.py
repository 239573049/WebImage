import json
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
ROOT_CONFIG_FILE = ROOT_DIR / "config.json"


class ConfigLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._created_root_config = False
        if not ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.write_text(json.dumps({"auth-key": "test-auth"}), encoding="utf-8")
            cls._created_root_config = True

        from services import config as config_module

        cls.config_module = config_module

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._created_root_config and ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.unlink()

    def test_load_settings_ignores_directory_config_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            config_dir = base_dir / "config.json"
            os_auth_key = "env-auth"

            config_dir.mkdir()

            module = self.config_module
            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_config_file = module.CONFIG_FILE
            old_env_auth_key = module.os.environ.get("CHATGPT2API_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.CONFIG_FILE = config_dir
                module.os.environ["CHATGPT2API_AUTH_KEY"] = os_auth_key

                settings = module._load_settings()

                self.assertEqual(settings.auth_key, os_auth_key)
                self.assertEqual(settings.refresh_account_interval_minute, 5)
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                module.CONFIG_FILE = old_config_file
                if old_env_auth_key is None:
                    module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)
                else:
                    module.os.environ["CHATGPT2API_AUTH_KEY"] = old_env_auth_key


class MeansEnvSeedTests(unittest.TestCase):
    MEANS_ENV = {
        "CHATGPT2API_MEANS_ENABLED": "true",
        "CHATGPT2API_MEANS_ENDPOINT": "http://127.0.0.1:5178/s3/",
        "CHATGPT2API_MEANS_ACCESS_KEY": "meansadmin",
        "CHATGPT2API_MEANS_SECRET_KEY": "env-secret",
        "CHATGPT2API_MEANS_BUCKET": "generated-images",
        "CHATGPT2API_MEANS_PUBLIC_BASE_URL": "https://files.example.com/generated-images",
    }

    @classmethod
    def setUpClass(cls) -> None:
        cls._created_root_config = False
        if not ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.write_text(json.dumps({"auth-key": "test-auth"}), encoding="utf-8")
            cls._created_root_config = True

        from services import config as config_module

        cls.config_module = config_module

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._created_root_config and ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.unlink()

    def _run_with_env(self, env: dict[str, str], config_data: dict) -> object:
        module = self.config_module
        old_env = {key: module.os.environ.get(key) for key in env}
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = Path(tmp_dir) / "config.json"
            config_path.write_text(json.dumps(config_data), encoding="utf-8")
            try:
                module.os.environ.update(env)
                return module.ConfigStore(config_path), config_path, json.loads(
                    config_path.read_text(encoding="utf-8")
                )
            finally:
                for key, value in old_env.items():
                    if value is None:
                        module.os.environ.pop(key, None)
                    else:
                        module.os.environ[key] = value

    def test_env_seeds_means_when_config_missing_means(self) -> None:
        store, _, saved = self._run_with_env(self.MEANS_ENV, {"auth-key": "test-auth"})

        means = store.get_means_settings()
        self.assertTrue(means["enabled"])
        self.assertEqual(means["endpoint"], "http://127.0.0.1:5178/s3")
        self.assertEqual(means["secret_key"], "env-secret")
        self.assertEqual(means["bucket"], "generated-images")
        # 初始化结果已持久化到 config.json
        self.assertEqual(saved["means"]["secret_key"], "env-secret")

    def test_env_does_not_override_existing_means_config(self) -> None:
        existing = {
            "auth-key": "test-auth",
            "means": {"enabled": False, "secret_key": "file-secret"},
        }
        store, _, saved = self._run_with_env(self.MEANS_ENV, existing)

        means = store.get_means_settings()
        self.assertFalse(means["enabled"])
        self.assertEqual(means["secret_key"], "file-secret")
        self.assertEqual(saved["means"]["secret_key"], "file-secret")

    def test_invalid_env_means_raises_clear_error(self) -> None:
        # 启用但缺少必填字段
        env = {"CHATGPT2API_MEANS_ENABLED": "true"}
        with self.assertRaises(ValueError) as ctx:
            self._run_with_env(env, {"auth-key": "test-auth"})
        self.assertIn("means", str(ctx.exception))

    def test_no_means_env_leaves_config_untouched(self) -> None:
        store, _, saved = self._run_with_env({}, {"auth-key": "test-auth"})
        self.assertNotIn("means", saved)
        self.assertFalse(store.get_means_settings()["enabled"])


if __name__ == "__main__":
    unittest.main()
