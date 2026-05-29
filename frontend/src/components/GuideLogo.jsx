/**
 * GuideLogo — Theme-tinted ZZZ mark via CSS mask.
 * Uses import.meta.env.BASE_URL so paths work in Electron (base: './') and dev server.
 */
export default function GuideLogo({ size = 20, className = '', title = 'guIDE', style = {} }) {
  const src = `${import.meta.env.BASE_URL}zzz.png`;
  return (
    <div
      title={title}
      className={`bg-vsc-accent flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        ...style,
      }}
      role="img"
      aria-label={title}
    />
  );
}
