import { useState, useRef, useEffect } from 'react';

export default function SlideDown({ isOpen, duration = 300, children }) {
  const [height, setHeight] = useState(0);
  const [renderChildren, setRenderChildren] = useState(isOpen);
  const contentRef = useRef(null);
  const timerRef = useRef(null);

  const measureHeight = () => {
    if (contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setRenderChildren(true);
      // Measure after paint
      requestAnimationFrame(() => {
        requestAnimationFrame(measureHeight);
      });
    } else {
      setHeight(0);
      timerRef.current = setTimeout(() => {
        setRenderChildren(false);
      }, duration);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isOpen, duration]);

  // Re-measure when nested content grows (e.g. explorer subfolders)
  useEffect(() => {
    if (!isOpen || !renderChildren || !contentRef.current) return;

    const node = contentRef.current;
    measureHeight();

    if (typeof ResizeObserver === 'undefined') return undefined;

    let rafId = null;
    const observer = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        measureHeight();
      });
    });
    observer.observe(node);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [isOpen, renderChildren]);

  return (
    <div
      className="overflow-hidden transition-all ease-out"
      style={{
        maxHeight: height,
        opacity: isOpen ? 1 : 0,
        transitionDuration: `${duration}ms`,
      }}
    >
      <div ref={contentRef}>
        {renderChildren ? children : null}
      </div>
    </div>
  );
}
