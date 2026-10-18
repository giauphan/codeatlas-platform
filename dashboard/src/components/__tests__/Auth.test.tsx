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
      expect(screen.getByRole('alert')).toHaveTextContent('Invalid token provided');
      expect(input).toHaveAttribute('aria-invalid', 'true');
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

  it.each([
    { mode: 'token', label: 'access key', inputLabel: 'NEURAL ACCESS KEY' },
    { mode: 'signin', label: 'password', inputLabel: 'PASSWORD' },
  ])('describes the next visibility action for the $label', async ({ mode, label, inputLabel }) => {
    const user = userEvent.setup();
    render(<Auth onLogin={vi.fn()} />);
    if (mode === 'signin') await user.click(screen.getByRole('tab', { name: 'SIGN IN' }));
    const input = await screen.findByLabelText(inputLabel, { exact: true });
    const showButton = screen.getByRole('button', { name: `Show ${label}` });
    expect(input).toHaveAttribute('type', 'password');
    expect(showButton).toHaveAttribute('title', `Show ${label}`);

    await user.click(showButton);
    const hideButton = screen.getByRole('button', { name: `Hide ${label}` });
    expect(input).toHaveAttribute('type', 'text');
    expect(hideButton).toHaveAttribute('title', `Hide ${label}`);

    await user.click(hideButton);
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: `Show ${label}` })).toHaveAttribute('title', `Show ${label}`);
  });

  it('announces sign-in errors and marks the credential fields invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'INVALID_PASSWORD' }),
    } as Response);
    try {
      const user = userEvent.setup();
      render(<Auth onLogin={vi.fn()} />);
      await user.click(screen.getByRole('tab', { name: 'SIGN IN' }));
      const email = await screen.findByLabelText('EMAIL ADDRESS');
      const password = screen.getByLabelText('PASSWORD', { exact: true });
      await user.type(email, 'person@example.com');
      await user.type(password, 'incorrect-password');
      await user.click(screen.getByRole('button', { name: 'ENTER SYSTEM' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
        expect(email).toHaveAttribute('aria-invalid', 'true');
        expect(password).toHaveAttribute('aria-invalid', 'true');
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

});
