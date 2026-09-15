interface ApplicationFrame {
  frameTreeNodeId: number;
  url: string;
  detached?: boolean;
}

export function isTrustedApplicationFrame(
  trustedContents: boolean,
  senderFrame: ApplicationFrame | null | undefined,
  mainFrame: Pick<ApplicationFrame, 'frameTreeNodeId'>,
): boolean {
  return trustedContents
    && !!senderFrame
    && !senderFrame.detached
    && senderFrame.frameTreeNodeId === mainFrame.frameTreeNodeId
    && senderFrame.url.startsWith('graycode://app/');
}
