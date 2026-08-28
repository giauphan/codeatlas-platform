import React from 'react';

interface KbdHintProps {
  icon: string;
  text: string;
  top: string;
  right: string;
}

export const KbdHint: React.FC<KbdHintProps> = ({ icon, text, top, right }) => {
  return (
    <div style={{ position: 'absolute', right, top, pointerEvents: 'none', transition: 'right 0.2s ease' }}>
      <kbd className="search-kbd-hint">
        <span className="search-kbd-hint-icon">{icon}</span> {text}
      </kbd>
    </div>
  );
};
