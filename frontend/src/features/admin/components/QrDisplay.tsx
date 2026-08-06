import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '../../../shared/ui';

/**
 * 固定二维码展示（FR-CHK-001、PRD §9.1 qr_token）。
 *
 * 二维码内容 = 完整落地链接（签到 /checkin/:activityId、问卷 /survey/:qrToken，
 * 由调用方以 window.location.origin 拼绝对 URL），内容固定、有效性由服务端开放状态
 * 控制，与二维码本身无关。
 *
 * 实现：qrcode 库本地生成 dataURL（无网络依赖），生成失败时回退为可复制链接。
 */
export function QrDisplay({
  url,
  caption,
  downloadName,
}: {
  url: string;
  caption?: string;
  /** 「下载二维码图片」的文件名（缺省 qrcode.png）。 */
  downloadName?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    QRCode.toDataURL(url, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) {
          setDataUrl(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const download = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = downloadName ?? 'qrcode.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文）时由用户手动复制下方链接文本
      setCopied(false);
    }
  };

  return (
    <div className="cc-qr">
      {dataUrl ? (
        <img className="cc-qr-image" src={dataUrl} alt={`二维码，链接：${url}`} />
      ) : (
        <div className="cc-qr-image cc-qr-placeholder" role="img" aria-label={`二维码生成中，链接：${url}`}>
          {failed ? '二维码生成失败，请使用下方链接' : '二维码生成中…'}
        </div>
      )}
      {caption ? <p className="cc-qr-caption">{caption}</p> : null}
      <p className="cc-qr-url">
        <code>{url}</code>
      </p>
      <Button variant="secondary" onClick={copy}>
        {copied ? '已复制' : '复制链接'}
      </Button>
      <Button variant="secondary" onClick={download} disabled={!dataUrl}>
        下载二维码图片
      </Button>
    </div>
  );
}
