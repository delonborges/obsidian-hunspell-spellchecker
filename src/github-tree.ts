import {GithubContentItem, GithubTreeItem} from "./types";

export function treeFiles(items: GithubTreeItem[], directory: string): GithubContentItem[] {
    return items
        .filter((item) => item.type === "blob" && item.path.lastIndexOf("/") > 0 && item.path.substring(0, item.path.lastIndexOf("/")) === directory)
        .map((item) => ({
            type: "file",
            name: item.path.substring(item.path.lastIndexOf("/") + 1),
            download_url: `https://raw.githubusercontent.com/LibreOffice/dictionaries/master/${item.path}`
        }));
}

export function treeDirectories(items: GithubTreeItem[]): GithubContentItem[] {
    return [...new Set(items
        .filter((item) => item.type === "blob")
        .map((item) => item.path.substring(0, item.path.lastIndexOf("/")))
        .filter((directory) => directory.length > 0))]
        .filter((directory) => !directory.startsWith(".") && !directory.split("/").some((part) => part.startsWith(".") || part === "util"))
        .sort()
        .map((name) => ({type: "dir", name}));
}
