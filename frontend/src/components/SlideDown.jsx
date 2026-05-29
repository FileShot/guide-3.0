import { useState, useRef, useEffect } from 'react';

export default function SlideDown({ isOpen, duration = 300, children }) {
  const [height, setHeight] = useState(0);
  const [renderChildren, setRenderChildren] = useState(isOpen);
  const contentRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setRenderChildren(true);
      // Measure next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (contentRef.current) {
            setHeight(contentRef.current.scrollHeight);
          }
        });
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
