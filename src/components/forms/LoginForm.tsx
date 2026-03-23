import { useAuth } from '@/hooks/useAuth';
import type { LoginCreds } from '@/services/auth';
import { cn } from '@/utils/classes';
import { TextField } from '@radix-ui/themes';
import type { AxiosError } from 'axios';
import { type FC, useState } from 'react';
import { Controller, type SubmitHandler, useForm } from 'react-hook-form';
import toast from 'react-hot-toast';

interface LoginFormProps {
  className?: string;
}

export const LoginForm: FC<LoginFormProps> = ({ className }) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login } = useAuth();

  const {
    control,
    handleSubmit,
    formState: { isValid, isDirty }
  } = useForm<LoginCreds>({
    mode: 'onChange',
    reValidateMode: 'onChange',
    defaultValues: {}
  });

  const onSubmit: SubmitHandler<LoginCreds> = async (_login) => {
    setIsSubmitting(true);
    try {
      await login(_login);
    } catch (error) {
      toast.error((error as AxiosError<{ message: string }>)?.response?.data?.message || 'Login failed');
    }
    setIsSubmitting(false);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Controller
        name="email"
        control={control}
        rules={{ required: 'Email is required' }}
        render={({ field: { onChange, value, onBlur } }) => (
          <TextField.Root value={value ?? ''} onChange={(e) => onChange(e?.target?.value)} onBlur={onBlur} placeholder="Email" type="email" />
        )}
      />
      <Controller
        name="password"
        control={control}
        rules={{ required: 'Password is required' }}
        render={({ field: { onChange, value, onBlur } }) => (
          <TextField.Root value={value ?? ''} onChange={(e) => onChange(e?.target?.value)} onBlur={onBlur} type="password" placeholder="Password" />
        )}
      />
      <button
        onClick={handleSubmit(onSubmit)}
        disabled={!isDirty || !isValid || isSubmitting}
        className="cursor-pointer rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? 'Logging in...' : 'Login'}
      </button>
    </div>
  );
};
