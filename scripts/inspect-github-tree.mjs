import fs from "node:fs";

const file = process.argv[2];
const pattern = new RegExp(process.argv[3] ?? ".", "i");
const tree = JSON.parse(fs.readFileSync(file, "utf8")).tree;
for (const entry of tree) {
	if (entry.type === "blob" && pattern.test(entry.path)) {
		console.log(`${entry.sha}\t${entry.size}\t${entry.path}`);
	}
}
