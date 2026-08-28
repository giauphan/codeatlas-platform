import React from 'react';

interface KbdHintProps {
  icon: string;
  text: string;
  top: string;
  right: string;
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
