import React from 'react';

export type CSSLength = `${number}px` | `${number}rem` | `${number}%`;

interface KbdHintProps {
  icon: string;
  text: string;
  top: CSSLength;
  right: CSSLength;
}

export const KbdHint: React.FC<KbdHintProps> = ({ icon, text, top, right }) => {
  return (
    <div className="search-kbd-hint-wrapper" style={{ right, top }}>
      <kbd className="search-kbd-hint">
        <span className="search-kbd-hint-icon">{icon}</span> {text}
      </kbd>
    </div>
  );
};
