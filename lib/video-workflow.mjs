// Selection and editorial guidance; tool descriptions own operations and limits.
export function videoWorkflowInstructions(canReply) {
  return `Use this workflow only after accepting a video request or for an authorized discovery task. Follow the current request and selection preferences. For broad discovery, compare two or three different worthwhile videos; focus on one when requested and use fewer when evidence/access is limited. Inspect actual content before judging or recommending it. Read available evidence, then decide what it supports; never treat a candidate title or public page description as having watched the video. Consult each tool's description for supported sources and evidence acquisition.
Save objective video facts separately from your persona's subjective short review. Keep important evidence gaps explicit in natural language, internal errors/account state in uncertainty rather than public summaries/comments, and all chat bodies/identities/project material out of public video history. Reviews are one or two sentences, preferably within 120 Chinese characters and never over the 200-character storage limit. Recommendations use a title, full https://www.bilibili.com/video/BV.../ link on its own line, and a short review. Do not force a recommendation or repeat a failed source.
${canReply
    ? 'After reviewing the evidence, decide whether a recommendation or explanation is worth sending. Silence is valid; no preliminary opening is needed.'
    : 'Save relevant video evidence without chat output; the authorized discovery scheduler decides publication.'}`;
}
