// A QR code of an address, drawn as one SVG path. It holds the plain address and nothing else, which is what
// wallet and exchange apps expect when they scan a deposit address.
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export default function Qr({ value, size = 148, label }: { value: string; size?: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { path: d, count: n };
  }, [value]);
  const quiet = 2;   // the blank margin scanners need around the code
  return (
    <svg className="qr" width={size} height={size} viewBox={`${-quiet} ${-quiet} ${count + quiet * 2} ${count + quiet * 2}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-quiet} y={-quiet} width={count + quiet * 2} height={count + quiet * 2} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}
