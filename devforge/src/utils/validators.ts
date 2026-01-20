export const validateHttpsUrl = (url: string): boolean => {
  if (!url.trim()) {
    return false;
  }
  try {
    const urlObj = new URL(url);
    if (!urlObj.protocol.startsWith("http")) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
};

export const validateEmail = (email: string): boolean => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

export const validatePassword = (password: string): boolean => {
  return password.length >= 8;
};

export const validateRequired = (value: string): boolean => {
  return value.trim().length > 0;
};