"""CI-only capture of the pinned provider's actual serializer and Deno argv.
No network, player download or real Popen; input consists only of owned fixtures.
Python is a test dependency, not a LearnLens runtime/learner requirement.
"""
import hashlib
import json
import pathlib
import sys
from types import SimpleNamespace

config = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
root = pathlib.Path(config["upstream"]).resolve()
sys.path.insert(0, str(root))
from yt_dlp.extractor.youtube.jsc._builtin import deno, ejs, vendor

assert vendor.VERSION == "0.8.0"
lib = pathlib.Path(config["lib"]).read_text(encoding="utf-8")
core = pathlib.Path(config["core"]).read_text(encoding="utf-8")
for name, code in [("yt.solver.lib.min.js", lib), ("yt.solver.core.min.js", core)]:
    assert hashlib.sha512(code.encode()).hexdigest() == vendor.HASHES[name]

captured = {}
class CapturePopen:
    def __init__(self, cmd, **options):
        captured["argv"] = cmd
        captured["envKeys"] = sorted(options["env"])
        self.returncode = 0
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def communicate_or_kill(self, stdin):
        captured["stdin"] = stdin
        return "{}", ""

deno.Popen = CapturePopen
instance = SimpleNamespace(
    _lib_script=SimpleNamespace(code=lib, variant=ejs.ScriptVariant.MINIFIED),
    _core_script=SimpleNamespace(code=core),
    _DENO_BASE_OPTIONS=deno.DenoJCP._DENO_BASE_OPTIONS,
    runtime_info=SimpleNamespace(path=config["deno"]),
    ie=SimpleNamespace(get_param=lambda name: False,
                       _downloader=SimpleNamespace(proxies={"all": config["proxy"]})),
    logger=SimpleNamespace(debug=lambda text: None),
    ejs_setting=lambda key, default: default,
)
instance._get_env_options = lambda: deno.DenoJCP._get_env_options(instance)
instance._clean_stderr = lambda stderr: deno.DenoJCP._clean_stderr(instance, stderr)
instance._run_deno = lambda stdin, options: deno.DenoJCP._run_deno(instance, stdin, options)
request = SimpleNamespace(type=ejs.JsChallengeType.N,
                          input=SimpleNamespace(challenges=["OWNED_CHALLENGE"]))
stdin = ejs.EJSBaseJCP._construct_stdin(instance, config["player"], False, [request])
deno.DenoJCP._run_js_runtime(instance, stdin)
assert captured["stdin"] == stdin
captured["version"] = vendor.VERSION
captured["playerEncodedAsJson"] = json.dumps(config["player"]) in stdin
captured["sourceHashes"] = {
    name: hashlib.sha256((root / path).read_text(encoding="utf-8").encode()).hexdigest()
    for name, path in {
        "deno": "yt_dlp/extractor/youtube/jsc/_builtin/deno.py",
        "ejs": "yt_dlp/extractor/youtube/jsc/_builtin/ejs.py",
    }.items()
}
print(json.dumps(captured))
