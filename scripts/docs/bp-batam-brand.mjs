export default function bpBatamBrand() {
  return (tree) => {
    const visit = (node) => {
      if (typeof node.value === "string")
        node.value = node.value
          .replace(/\bOmniRouter?\b/g, "BP Batam AI Gateway")
          .replace(/\bKeak\b/g, "BP Batam");
      if (typeof node.title === "string")
        node.title = node.title.replace(/\bOmniRouter?\b/g, "BP Batam AI Gateway");
      if (
        typeof node.url === "string" &&
        /omniroute\.online|keak\.ai|github\.com\/(cheaper-inference|diegosouzapw)\/OmniRoute/.test(
          node.url
        )
      )
        node.url = "/dashboard/help";
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}
