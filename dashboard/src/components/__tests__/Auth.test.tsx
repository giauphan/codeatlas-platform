import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Auth from '../Auth'
import { vi } from 'vitest'

vi.mock('../../lib/firebase', () => ({
  auth: {},
  db: {}
}));

vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn()
}));

describe('Auth Component', () => {
  it('shows error message when onLogin throws an error', async () => {
    const mockOnLogin = vi.fn().mockRejectedValue(new Error('Invalid token provided'));

    render(<Auth onLogin={mockOnLogin} />);

    const input = screen.getByPlaceholderText('Enter your Enterprise Key...');
    const submitButton = screen.getByText('INITIALIZE SESSION');

    await userEvent.type(input, 'invalid-key');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid token provided')).toBeInTheDocument();
    });
  });

  it('shows default error message when onLogin throws without a specific message', async () => {
    const mockOnLogin = vi.fn().mockRejectedValue({});

    render(<Auth onLogin={mockOnLogin} />);

    const input = screen.getByPlaceholderText('Enter your Enterprise Key...');
    const submitButton = screen.getByText('INITIALIZE SESSION');

    await userEvent.type(input, 'invalid-key');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Invalid API Key or Token')).toBeInTheDocument();
    });
  });

  it('calls onLogin with trimmed input', async () => {
    const mockOnLogin = vi.fn().mockResolvedValue(undefined);

    render(<Auth onLogin={mockOnLogin} />);

    const input = screen.getByPlaceholderText('Enter your Enterprise Key...');
    const submitButton = screen.getByText('INITIALIZE SESSION');

    await userEvent.type(input, '  valid-key  ');
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnLogin).toHaveBeenCalledWith('valid-key');
    });
  });

  it('does not call onLogin with empty input', async () => {
     const mockOnLogin = vi.fn();

     render(<Auth onLogin={mockOnLogin} />);

     const input = screen.getByPlaceholderText('Enter your Enterprise Key...');
     const submitButton = screen.getByText('INITIALIZE SESSION');

     await userEvent.type(input, '   ');
     await userEvent.click(submitButton);

     await waitFor(() => {
       expect(mockOnLogin).not.toHaveBeenCalled();
     });
  });
});
