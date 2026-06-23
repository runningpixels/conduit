interface InterruptedBannerProps {
  visible: boolean;
}

export function InterruptedBanner({ visible }: InterruptedBannerProps) {
  if (!visible) {
    return null;
  }
  return (
    <div className="interrupted-banner" role="status">
      Generation stopped. Partial output was saved.
    </div>
  );
}