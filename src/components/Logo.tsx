interface LogoProps {
  className?: string;
  size?: number;
}

export function Logo({ className = "", size = 32 }: LogoProps) {
  return (
    <div className={`logo ${className}`} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M16 28C22.6274 28 28 22.6274 28 16C28 9.37258 22.6274 4 16 4C9.37258 4 4 9.37258 4 16C4 18.0051 4.49132 19.8967 5.35825 21.5602L4 28L10.4398 26.6418C12.1033 27.5087 13.9949 28 16 28Z"
          stroke="url(#logo_gradient)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 10C16 10 16.5 13.5 20 15C16.5 16.5 16 20 16 20C16 20 15.5 16.5 12 15C15.5 13.5 16 10 16 10Z"
          fill="var(--accent)"
        />
        <defs>
          <linearGradient
            id="logo_gradient"
            x1="4"
            y1="4"
            x2="28"
            y2="28"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="var(--accent)" />
            <stop offset="1" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
