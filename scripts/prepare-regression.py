"""Make isolated regression copies; never modify original music folders."""
import hashlib
import json
import pathlib
import shutil
import sys
import zipfile

workspace=pathlib.Path.cwd().resolve()
root=pathlib.Path(sys.argv[1]).resolve()
if not root.is_relative_to(workspace/'test-results'):raise RuntimeError('Regression destination must stay in test-results')
root.mkdir(parents=True,exist_ok=False)
# Restore expendable fixtures from the historical v1.1 packages only.
# Product code never extracts, edits, or rebuilds these archives.
for name in ['миг','Kontakt mix']:
    with zipfile.ZipFile(workspace/'test-results'/'regression-2026-10-17T08-13-50-127Z'/(name+'.zip')) as archive:
        manifest=json.loads(archive.read('__flpack__/manifest.json'))
        for entry in manifest['files']:
            target=(root/name/entry['relative']).resolve()
            if not target.is_relative_to(root/name):raise RuntimeError('Unsafe source path in manifest')
            target.parent.mkdir(parents=True,exist_ok=True)
            digest=hashlib.sha256()
            with archive.open(entry['entry'])as input,target.open('xb')as output:
                while block:=input.read(1024*1024):digest.update(block);output.write(block)
            if digest.hexdigest()!=entry['sha256']:raise RuntimeError('Restored source hash mismatch')
print(str(root))
