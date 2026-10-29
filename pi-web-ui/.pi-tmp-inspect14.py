import io
p = "web/src/components/DirectoryBrowser.tsx"
lines = io.open(p, encoding="utf-8").read().split("\n")
for i, line in enumerate(lines):
    if 't("newProject")' in line or 't("projectName")' in line or 't("createAndOpenProject")' in line:
        n = len(line) - len(line.lstrip("\t"))
        print(i + 1, n, repr(line[:90]))
